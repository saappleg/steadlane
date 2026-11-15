const SESSION_KEY_PREFIX = "steadlane.auth.v1";

function parseResponseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function authMessage(payload, fallback) {
  const message = payload?.msg || payload?.message || payload?.error_description || payload?.error;
  return typeof message === "string" && message.length <= 300 ? message : fallback;
}

function asSession(payload) {
  if (
    !payload ||
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string"
  ) {
    throw new Error("Sign-in did not return a valid session.");
  }

  const expiresIn = Number(payload.expires_in);
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    token_type: typeof payload.token_type === "string" ? payload.token_type : "bearer",
    expires_at: Number.isFinite(expiresIn)
      ? Math.floor(Date.now() / 1000) + expiresIn
      : null,
    user: payload.user && typeof payload.user === "object" ? payload.user : null,
  };
}

function authResult(data = null, error = null) {
  return { data, error };
}

/**
 * Create the browser-side Supabase Auth client used by the booking UI.
 * The public publishable key identifies the app; each signed-in request uses
 * the caller's access token. No elevated key is accepted by this module.
 */
export function createAuthClient({ supabaseUrl, supabasePublishableKey }) {
  if (typeof supabaseUrl !== "string" || typeof supabasePublishableKey !== "string") {
    throw new TypeError("Supabase URL and publishable key are required.");
  }

  const projectUrl = new URL(supabaseUrl);
  const localHost = ["localhost", "127.0.0.1"].includes(projectUrl.hostname);
  const validSupabaseHost = projectUrl.hostname.endsWith(".supabase.co");
  if (
    (projectUrl.protocol !== "https:" && !(localHost && projectUrl.protocol === "http:")) ||
    (!validSupabaseHost && !localHost) ||
    projectUrl.pathname !== "/" ||
    projectUrl.search ||
    projectUrl.hash ||
    projectUrl.username ||
    projectUrl.password
  ) {
    throw new TypeError("Supabase URL must use HTTPS, except for a local development server.");
  }
  if (!supabasePublishableKey.startsWith("sb_publishable_")) {
    throw new TypeError("A Supabase publishable key is required.");
  }

  const baseUrl = projectUrl.href.replace(/\/+$/, "");
  const storageKey = `${SESSION_KEY_PREFIX}.${projectUrl.hostname}`;
  const listeners = new Set();

  function readStoredSession() {
    try {
      const value = sessionStorage.getItem(storageKey);
      if (!value) return null;
      const session = JSON.parse(value);
      return typeof session?.access_token === "string" && typeof session?.refresh_token === "string"
        ? session
        : null;
    } catch {
      return null;
    }
  }

  function emitAuthEvent(event, session) {
    for (const listener of listeners) listener(event, session);
  }

  function storeSession(session, event = "SIGNED_IN") {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(session));
    } catch {
      throw new Error("This browser could not store the sign-in session.");
    }
    emitAuthEvent(event, session);
  }

  function removeSession(event = "SIGNED_OUT") {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // The API still checks the access token; storage is only local session state.
    }
    emitAuthEvent(event, null);
  }

  async function authRequest(path, { method = "POST", body, accessToken } = {}) {
    const headers = new Headers({
      apikey: supabasePublishableKey,
      accept: "application/json",
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);

    let response;
    try {
      response = await fetch(`${baseUrl}/auth/v1/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      throw new Error("Could not reach the sign-in service. Check your connection and try again.");
    }

    const payload = parseResponseBody(await response.text());
    if (!response.ok) {
      throw new Error(authMessage(payload, "Sign-in could not be completed. Try again."));
    }
    return payload;
  }

  function restoreRedirectSession() {
    if (typeof window === "undefined" || !window.location.hash) return;

    const values = new URLSearchParams(window.location.hash.slice(1));
    const error = values.get("error_description") || values.get("error");
    if (error) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      throw new Error(error.slice(0, 300));
    }

    const accessToken = values.get("access_token");
    const refreshToken = values.get("refresh_token");
    if (!accessToken || !refreshToken) return;

    const expiresIn = Number(values.get("expires_in"));
    const session = {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: values.get("token_type") || "bearer",
      expires_at: Number.isFinite(expiresIn) ? Math.floor(Date.now() / 1000) + expiresIn : null,
      user: null,
    };
    const event = values.get("type") === "recovery" ? "PASSWORD_RECOVERY" : "SIGNED_IN";
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    storeSession(session, event);
  }

  async function refreshSession(session) {
    try {
      const payload = await authRequest("token?grant_type=refresh_token", {
        body: { refresh_token: session.refresh_token },
      });
      const refreshed = asSession(payload);
      storeSession(refreshed, "TOKEN_REFRESHED");
      return refreshed;
    } catch (error) {
      removeSession("SIGNED_OUT");
      throw error;
    }
  }

  async function getSessionValue() {
    restoreRedirectSession();
    const session = readStoredSession();
    if (!session) return null;

    const expiresAt = Number(session.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= Math.floor(Date.now() / 1000) + 60) {
      return refreshSession(session);
    }
    return session;
  }

  async function performSignUp({ email, password, options = {} }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (normalizedEmail.length < 3 || normalizedEmail.length > 254 || !normalizedEmail.includes("@")) {
      throw new TypeError("Enter a valid email address.");
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 256) {
      throw new TypeError("Use a password between 8 and 256 characters.");
    }

    const origin = typeof window === "undefined" ? undefined : window.location.origin;
    const emailRedirectTo = typeof options.emailRedirectTo === "string" ? options.emailRedirectTo : origin;
    if (emailRedirectTo && origin && new URL(emailRedirectTo).origin !== origin) {
      throw new TypeError("Email confirmation must return to this site.");
    }

    const inputMetadata = options.data && typeof options.data === "object" && !Array.isArray(options.data)
      ? options.data
      : {};
    const data = {};
    if (typeof inputMetadata.full_name === "string") {
      const fullName = inputMetadata.full_name.trim();
      if (fullName.length < 2 || fullName.length > 120) {
        throw new TypeError("Enter a name between 2 and 120 characters.");
      }
      data.full_name = fullName;
    }
    if (typeof inputMetadata.phone === "string" && inputMetadata.phone.trim()) {
      const phone = inputMetadata.phone.trim();
      if (phone.length < 7 || phone.length > 25 || !/^[+0-9() .-]+$/.test(phone) || !/\d/.test(phone)) {
        throw new TypeError("Enter a phone number with 7 to 25 characters and at least one digit.");
      }
      data.phone = phone;
    }

    const path = emailRedirectTo
      ? `signup?redirect_to=${encodeURIComponent(emailRedirectTo)}`
      : "signup";
    const payload = await authRequest(path, { body: { email: normalizedEmail, password, data } });
    if (payload?.access_token && payload?.refresh_token) {
      const session = asSession(payload);
      storeSession(session);
      return { user: payload.user || null, session };
    }
    return { user: payload?.user || null, session: null };
  }

  async function performSignInWithPassword({ email, password }) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || typeof password !== "string" || !password) {
      throw new TypeError("Enter your email and password.");
    }
    const payload = await authRequest("token?grant_type=password", {
      body: { email: normalizedEmail, password },
    });
    const session = asSession(payload);
    storeSession(session);
    return { user: session.user, session };
  }

  async function performSignOut() {
    const session = readStoredSession();
    if (!session?.access_token) {
      removeSession();
      return;
    }
    try {
      await authRequest("logout", { accessToken: session.access_token });
    } finally {
      removeSession();
    }
  }

  const auth = Object.freeze({
    onAuthStateChange(callback) {
      if (typeof callback !== "function") throw new TypeError("A callback function is required.");
      listeners.add(callback);
      const subscription = Object.freeze({ unsubscribe: () => listeners.delete(callback) });
      return { data: { subscription }, error: null };
    },

    async getSession() {
      try {
        return authResult({ session: await getSessionValue() });
      } catch (error) {
        return authResult({ session: null }, error);
      }
    },

    async signInWithPassword(credentials) {
      try {
        return authResult(await performSignInWithPassword(credentials));
      } catch (error) {
        return authResult({ user: null, session: null }, error);
      }
    },

    async signUp(credentials) {
      try {
        return authResult(await performSignUp(credentials));
      } catch (error) {
        return authResult({ user: null, session: null }, error);
      }
    },

    async signOut() {
      try {
        await performSignOut();
        return authResult();
      } catch (error) {
        return authResult(null, error);
      }
    },

    async resetPasswordForEmail(email) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      if (normalizedEmail.length < 3 || normalizedEmail.length > 254 || !normalizedEmail.includes("@")) {
        return authResult(null, new TypeError("Enter a valid email address."));
      }
      const origin = typeof window === "undefined" ? undefined : window.location.origin;
      const path = origin ? `recover?redirect_to=${encodeURIComponent(origin)}` : "recover";
      try {
        await authRequest(path, { body: { email: normalizedEmail } });
        return authResult();
      } catch (error) {
        return authResult(null, error);
      }
    },

    async updatePassword(password) {
      if (typeof password !== "string" || password.length < 8 || password.length > 256) {
        return authResult(null, new TypeError("Use a password between 8 and 256 characters."));
      }
      try {
        const session = await getSessionValue();
        if (!session?.access_token) throw new Error("Sign in to update your password.");
        const user = await authRequest("user", {
          method: "PUT",
          accessToken: session.access_token,
          body: { password },
        });
        const updatedSession = { ...session, user };
        storeSession(updatedSession, "USER_UPDATED");
        return authResult({ user, session: updatedSession });
      } catch (error) {
        return authResult(null, error);
      }
    },
  });

  return Object.freeze({
    auth,
    async getAccessToken() {
      const session = await getSessionValue();
      return session?.access_token || null;
    },
  });
}
