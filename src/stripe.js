const STRIPE_API_ORIGIN = "https://api.stripe.com";
const STRIPE_CHECKOUT_HOST = "checkout.stripe.com";
const WEBHOOK_TOLERANCE_SECONDS = 300;
const STRIPE_REQUEST_TIMEOUT_MS = 15_000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireTestSecret(env) {
  const secretKey = typeof env.STRIPE_SECRET_KEY === "string" ? env.STRIPE_SECRET_KEY.trim() : "";
  if (!/^sk_test_[A-Za-z0-9_]{20,}$/.test(secretKey)) {
    throw new Error("Stripe test credentials are not configured.");
  }
  return secretKey;
}

function optionalTaxSettings(env) {
  const enabled = env.STRIPE_AUTOMATIC_TAX_ENABLED;
  if (enabled === undefined || enabled === null || enabled === "" || enabled === "false") {
    return null;
  }
  if (enabled !== "true") throw new Error("Stripe Tax configuration is invalid.");

  const confirmed = env.STRIPE_TAX_REGISTRATION_CONFIRMED === "true" &&
    env.STRIPE_TAX_TREATMENT_CONFIRMED === "true";
  const taxCode = typeof env.STRIPE_TAX_CODE === "string" ? env.STRIPE_TAX_CODE.trim() : "";
  const taxBehavior = env.STRIPE_TAX_BEHAVIOR;
  if (
    !confirmed ||
    !/^txcd_[A-Za-z0-9]+$/.test(taxCode) ||
    !["exclusive", "inclusive"].includes(taxBehavior)
  ) {
    throw new Error("Stripe Tax requires confirmed registration, service treatment, a tax code, and tax behavior.");
  }
  return { taxCode, taxBehavior };
}

async function stripeRequest(env, path, { method = "GET", body, idempotencyKey } = {}) {
  const secretKey = requireTestSecret(env);
  const url = new URL(path, STRIPE_API_ORIGIN);
  const headers = new Headers({
    authorization: `Bearer ${secretKey}`,
    accept: "application/json",
  });
  if (body) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body?.toString(),
      signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new Error("Stripe could not be reached.");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Stripe returned an invalid response.");
  }
  if (!response.ok || !isPlainObject(payload)) {
    throw new Error("Stripe could not complete the payment request.");
  }
  return payload;
}

function validateCheckoutInput(input) {
  if (!isPlainObject(input)) throw new Error("Checkout details are invalid.");
  const { paymentAttemptId, bookingId, amountCents, currency, pickupAt, successUrl, cancelUrl } = input;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(paymentAttemptId) || !uuidPattern.test(bookingId)) {
    throw new Error("Checkout identifiers are invalid.");
  }
  const normalizedCurrency = typeof currency === "string" ? currency.toLowerCase() : "";
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 500_000 || normalizedCurrency !== "usd") {
    throw new Error("The stored fare is not payable.");
  }
  if (typeof pickupAt !== "string" || !Number.isFinite(Date.parse(pickupAt))) {
    throw new Error("The scheduled pickup time is invalid.");
  }

  let success;
  let cancel;
  try {
    success = new URL(successUrl);
    cancel = new URL(cancelUrl);
  } catch {
    throw new Error("Checkout return addresses are invalid.");
  }
  const allowedProtocol = (url) => url.protocol === "https:" ||
    ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.protocol === "http:");
  if (
    success.origin !== cancel.origin ||
    !allowedProtocol(success) ||
    !allowedProtocol(cancel) ||
    success.username || success.password || cancel.username || cancel.password
  ) {
    throw new Error("Checkout return addresses are invalid.");
  }
  return { paymentAttemptId, bookingId, amountCents, currency: normalizedCurrency, pickupAt, successUrl: success.href, cancelUrl: cancel.href };
}

function validateCheckoutSession(session, expectedId = null) {
  if (
    !isPlainObject(session) ||
    typeof session.id !== "string" ||
    !/^cs_test_[A-Za-z0-9]+$/.test(session.id) ||
    (expectedId !== null && session.id !== expectedId) ||
    session.livemode !== false
  ) {
    throw new Error("Stripe returned a session outside the configured test environment.");
  }
  if (session.url !== null && session.url !== undefined) {
    let parsedUrl;
    try {
      parsedUrl = new URL(session.url);
    } catch {
      throw new Error("Stripe returned an invalid Checkout address.");
    }
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== STRIPE_CHECKOUT_HOST ||
      !parsedUrl.pathname.startsWith(`/c/pay/${session.id}`)
    ) {
      throw new Error("Stripe returned an invalid Checkout address.");
    }
  }
  return session;
}

/** Create a card-only test Checkout Session using the persisted ride fare. */
export async function createStripeCheckoutSession(env, input) {
  const details = validateCheckoutInput(input);
  const tax = optionalTaxSettings(env);
  const body = new URLSearchParams({
    mode: "payment",
    "success_url": details.successUrl,
    "cancel_url": details.cancelUrl,
    "client_reference_id": details.bookingId,
    "payment_method_types[0]": "card",
    "submit_type": "book",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": details.currency,
    "line_items[0][price_data][unit_amount]": String(details.amountCents),
    "line_items[0][price_data][product_data][name]": "Steadlane scheduled ride",
    "line_items[0][price_data][product_data][description]": `Scheduled pickup ${new Date(details.pickupAt).toISOString()}`,
    "metadata[steadlane_booking_id]": details.bookingId,
    "metadata[steadlane_payment_attempt_id]": details.paymentAttemptId,
    "metadata[booking_id]": details.bookingId,
    "metadata[payment_attempt_id]": details.paymentAttemptId,
    "payment_intent_data[metadata][steadlane_booking_id]": details.bookingId,
    "payment_intent_data[metadata][steadlane_payment_attempt_id]": details.paymentAttemptId,
    "payment_intent_data[metadata][booking_id]": details.bookingId,
    "payment_intent_data[metadata][payment_attempt_id]": details.paymentAttemptId,
  });
  if (tax) {
    body.set("automatic_tax[enabled]", "true");
    body.set("billing_address_collection", "required");
    body.set("line_items[0][price_data][tax_behavior]", tax.taxBehavior);
    body.set("line_items[0][price_data][product_data][tax_code]", tax.taxCode);
  }

  const session = validateCheckoutSession(await stripeRequest(env, "/v1/checkout/sessions", {
    method: "POST",
    body,
    idempotencyKey: `steadlane-${details.paymentAttemptId}`,
  }));
  if (!Number.isInteger(session.expires_at) || session.expires_at <= 0) {
    throw new Error("Stripe returned an incomplete Checkout Session.");
  }
  if (session.status === "expired") return session;
  if (session.status !== "open" || typeof session.url !== "string") {
    throw new Error("Stripe returned an incomplete Checkout Session.");
  }
  return session;
}

/** Retrieve an existing test-mode Checkout Session to confirm it is still open before reuse. */
export async function retrieveStripeCheckoutSession(env, sessionId) {
  if (typeof sessionId !== "string" || !/^cs_test_[A-Za-z0-9]+$/.test(sessionId)) {
    throw new Error("Checkout session ID is invalid.");
  }
  return validateCheckoutSession(
    await stripeRequest(env, `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`),
    sessionId,
  );
}

function signatureParts(signatureHeader) {
  if (typeof signatureHeader !== "string" || signatureHeader.length > 4096) return null;
  const parts = new Map();
  for (const item of signatureHeader.split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!value) continue;
    if (key === "v1") {
      const signatures = parts.get("v1") || [];
      signatures.push(value);
      parts.set("v1", signatures);
    } else if (key === "t" && !parts.has("t")) {
      parts.set("t", value);
    }
  }
  const timestampText = parts.get("t");
  const signatures = parts.get("v1");
  if (!/^\d{1,12}$/.test(timestampText || "") || !signatures?.length) return null;
  return { timestamp: Number(timestampText), signatures };
}

function hexToBytes(value) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Verify Stripe's timestamped v1 signature over the exact raw request body. */
export async function verifyStripeWebhook(rawBody, signatureHeader, webhookSecret, nowMs = Date.now()) {
  if (
    typeof rawBody !== "string" ||
    typeof webhookSecret !== "string" ||
    !/^whsec_[A-Za-z0-9_]{20,}$/.test(webhookSecret) ||
    !Number.isFinite(nowMs)
  ) return null;
  const parsedHeader = signatureParts(signatureHeader);
  if (!parsedHeader || Math.abs(Math.floor(nowMs / 1000) - parsedHeader.timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    return null;
  }

  let key;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  const signedPayload = new TextEncoder().encode(`${parsedHeader.timestamp}.${rawBody}`);
  let valid = false;
  for (const signature of parsedHeader.signatures) {
    const supplied = hexToBytes(signature);
    if (!supplied) continue;
    try {
      valid = await crypto.subtle.verify("HMAC", key, supplied, signedPayload);
    } catch {
      valid = false;
    }
    if (valid) break;
  }
  if (!valid) return null;

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (
    !isPlainObject(event) ||
    typeof event.id !== "string" ||
    !/^evt_[A-Za-z0-9]+$/.test(event.id) ||
    typeof event.type !== "string" ||
    event.livemode !== false ||
    !isPlainObject(event.data) ||
    !isPlainObject(event.data.object)
  ) return null;
  return event;
}
