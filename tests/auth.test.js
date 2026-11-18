import test from "node:test";
import assert from "node:assert/strict";
import { createAuthClient } from "../src/auth.js";

const PROJECT_URL = "https://steadlane-test.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test-key";
const ORIGIN = "https://steadlane.example";

function browserHarness(t, responder, { hash = "" } = {}) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const values = new Map();
  const calls = [];
  const location = { origin: ORIGIN, pathname: "/", search: "", hash };
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location,
      history: {
        replaceState(_state, _title, path) {
          const parsed = new URL(path, location.origin);
          location.pathname = parsed.pathname;
          location.search = parsed.search;
          location.hash = parsed.hash;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input, init = {}) => {
      const url = new URL(input);
      calls.push({ url, init, headers: new Headers(init.headers) });
      return responder({ url, init, headers: new Headers(init.headers), calls });
    },
  });

  t.after(() => {
    for (const [name, descriptor] of [
      ["window", originalWindow],
      ["sessionStorage", originalStorage],
      ["fetch", originalFetch],
    ]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  return { calls, location, storage, values };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createClient() {
  return createAuthClient({ supabaseUrl: PROJECT_URL, supabasePublishableKey: PUBLISHABLE_KEY });
}

test("auth client accepts only Supabase publishable configuration", () => {
  assert.throws(
    () => createAuthClient({ supabaseUrl: "http://steadlane-test.supabase.co", supabasePublishableKey: PUBLISHABLE_KEY }),
    /Supabase URL must use HTTPS/,
  );
  assert.throws(
    () => createAuthClient({ supabaseUrl: PROJECT_URL, supabasePublishableKey: "sb_secret_private" }),
    /publishable key is required/,
  );
  assert.throws(
    () => createAuthClient({ supabaseUrl: "https://attacker.example", supabasePublishableKey: PUBLISHABLE_KEY }),
    /Supabase URL must use HTTPS/,
  );
});

test("sign-up normalizes email and sends only passenger contact metadata", async (t) => {
  const harness = browserHarness(t, () => jsonResponse({ user: { id: "passenger-1" } }));
  const client = createClient();
  const result = await client.auth.signUp({
    email: "  Passenger@Example.com ",
    password: "correct-horse-battery",
    options: {
      data: { full_name: "Passenger One", phone: "+1 (555) 555-0100", role: "driver" },
      emailRedirectTo: `${ORIGIN}/`,
    },
  });

  assert.equal(result.error, null);
  assert.equal(result.data.user.id, "passenger-1");
  assert.equal(result.data.session, null);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].url.pathname, "/auth/v1/signup");
  assert.equal(harness.calls[0].url.searchParams.get("redirect_to"), `${ORIGIN}/`);
  assert.equal(harness.calls[0].headers.get("apikey"), PUBLISHABLE_KEY);
  assert.equal(harness.calls[0].headers.has("authorization"), false);
  assert.deepEqual(JSON.parse(harness.calls[0].init.body), {
    email: "passenger@example.com",
    password: "correct-horse-battery",
    data: { full_name: "Passenger One", phone: "+1 (555) 555-0100" },
  });
});

test("sign-up rejects a phone number with no digits before contacting Auth", async (t) => {
  const harness = browserHarness(t, () => jsonResponse({ user: { id: "passenger-1" } }));
  const result = await createClient().auth.signUp({
    email: "passenger@example.com",
    password: "correct-horse-battery",
    options: { data: { full_name: "Passenger One", phone: "---   ()" } },
  });

  assert.match(result.error.message, /at least one digit/);
  assert.equal(harness.calls.length, 0);
});

test("sign-in stores a session and exposes its access token", async (t) => {
  const session = {
    access_token: "header.payload.signature",
    refresh_token: "refresh-secret",
    expires_in: 3600,
    user: { id: "passenger-1", email: "passenger@example.com" },
  };
  const harness = browserHarness(t, () => jsonResponse(session));
  const client = createClient();
  const events = [];
  client.auth.onAuthStateChange((event, value) => events.push([event, value]));

  const result = await client.auth.signInWithPassword({ email: "Passenger@Example.com", password: "password123" });

  assert.equal(result.error, null);
  assert.equal(result.data.session.access_token, session.access_token);
  assert.equal(await client.getAccessToken(), session.access_token);
  assert.equal(harness.calls[0].url.pathname, "/auth/v1/token");
  assert.equal(harness.calls[0].url.searchParams.get("grant_type"), "password");
  assert.equal(events[0][0], "SIGNED_IN");
  assert.equal(JSON.parse(harness.values.get("steadlane.auth.v1.steadlane-test.supabase.co")).refresh_token, "refresh-secret");
});

test("expired sessions refresh before returning an access token", async (t) => {
  const refreshed = {
    access_token: "new.header.signature",
    refresh_token: "new-refresh-secret",
    expires_in: 3600,
    user: { id: "passenger-1" },
  };
  const harness = browserHarness(t, () => jsonResponse(refreshed));
  const storageKey = "steadlane.auth.v1.steadlane-test.supabase.co";
  harness.storage.setItem(storageKey, JSON.stringify({
    access_token: "old.header.signature",
    refresh_token: "old-refresh-secret",
    expires_at: 1,
  }));
  const client = createClient();
  const events = [];
  client.auth.onAuthStateChange((event) => events.push(event));

  assert.equal(await client.getAccessToken(), refreshed.access_token);
  assert.equal(harness.calls[0].url.searchParams.get("grant_type"), "refresh_token");
  assert.deepEqual(JSON.parse(harness.calls[0].init.body), { refresh_token: "old-refresh-secret" });
  assert.deepEqual(events, ["TOKEN_REFRESHED"]);
});

test("recovery links restore their session and emit the recovery event", async (t) => {
  const harness = browserHarness(t, () => jsonResponse({}), {
    hash: "#access_token=recovery.header.signature&refresh_token=recovery-refresh&expires_in=3600&type=recovery",
  });
  const client = createClient();
  const events = [];
  client.auth.onAuthStateChange((event, session) => events.push([event, session?.access_token]));

  const result = await client.auth.getSession();

  assert.equal(result.error, null);
  assert.equal(result.data.session.access_token, "recovery.header.signature");
  assert.equal(harness.location.hash, "");
  assert.deepEqual(events, [["PASSWORD_RECOVERY", "recovery.header.signature"]]);
});

test("reset links stay on the current site and password updates use the signed-in token", async (t) => {
  const harness = browserHarness(t, ({ url }) => {
    if (url.pathname.endsWith("/recover")) return jsonResponse({});
    if (url.pathname.endsWith("/user")) return jsonResponse({ id: "passenger-1" });
    return jsonResponse({ message: "unexpected request" }, 404);
  });
  const client = createClient();
  const resetResult = await client.auth.resetPasswordForEmail(" Passenger@Example.com ");
  assert.equal(resetResult.error, null);
  assert.equal(harness.calls[0].url.pathname, "/auth/v1/recover");
  assert.equal(harness.calls[0].url.searchParams.get("redirect_to"), ORIGIN);
  assert.equal(JSON.parse(harness.calls[0].init.body).email, "passenger@example.com");

  harness.storage.setItem("steadlane.auth.v1.steadlane-test.supabase.co", JSON.stringify({
    access_token: "recovery.header.signature",
    refresh_token: "recovery-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const updateResult = await client.auth.updatePassword("new-password-123");
  assert.equal(updateResult.error, null);
  const updateCall = harness.calls[1];
  assert.equal(updateCall.url.pathname, "/auth/v1/user");
  assert.equal(updateCall.init.method, "PUT");
  assert.equal(updateCall.headers.get("authorization"), "Bearer recovery.header.signature");
  assert.deepEqual(JSON.parse(updateCall.init.body), { password: "new-password-123" });
});
