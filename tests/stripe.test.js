import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createStripeCheckoutSession, verifyStripeWebhook } from "../src/stripe.js";

const SECRET_KEY = "sk_test_steadlane_test_only_001";
const RESTRICTED_KEY = "rk_test_steadlane_test_only_001";
const WEBHOOK_SECRET = "whsec_steadlane_test_only_secret_001";

function installFetchMock(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

function checkoutArgs(overrides = {}) {
  return {
    paymentAttemptId: "77777777-7777-4777-8777-777777777777",
    bookingId: "88888888-8888-4888-8888-888888888888",
    amountCents: 2_800,
    currency: "usd",
    pickupAt: "2027-01-15T16:30:00.000Z",
    successUrl: "https://steadlane.example/?checkout=return&booking_id=88888888-8888-4888-8888-888888888888",
    cancelUrl: "https://steadlane.example/?checkout=return&booking_id=88888888-8888-4888-8888-888888888888",
    ...overrides,
  };
}

test("Checkout uses the server fare snapshot and leaves payment methods to Stripe settings", async (t) => {
  let request;
  installFetchMock(t, async (input, init = {}) => {
    request = { url: new URL(input), init };
    return new Response(JSON.stringify({
      id: "cs_test_steadlane001",
      url: "https://checkout.stripe.com/c/pay/cs_test_steadlane001",
      status: "open",
      payment_status: "unpaid",
      livemode: false,
      expires_at: Math.floor(Date.now() / 1000) + 1_800,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const session = await createStripeCheckoutSession(
    { STRIPE_SECRET_KEY: SECRET_KEY },
    checkoutArgs(),
  );

  assert.equal(session.id, "cs_test_steadlane001");
  assert.equal(session.livemode, false);
  assert.equal(request.url.href, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(request.init.method, "POST");
  assert.equal(new Headers(request.init.headers).get("authorization"), `Bearer ${SECRET_KEY}`);
  assert.ok(new Headers(request.init.headers).get("idempotency-key"));

  const fields = new URLSearchParams(request.init.body);
  assert.equal(fields.get("mode"), "payment");
  assert.equal([...fields.keys()].some((name) => name.startsWith("payment_method_types[")), false);
  assert.equal(fields.get("line_items[0][price_data][unit_amount]"), "2800");
  assert.equal(fields.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(fields.get("metadata[steadlane_booking_id]"), "88888888-8888-4888-8888-888888888888");
  assert.equal(fields.get("metadata[steadlane_payment_attempt_id]"), "77777777-7777-4777-8777-777777777777");
  assert.equal(fields.get("success_url"), checkoutArgs().successUrl);
  assert.equal(fields.get("cancel_url"), checkoutArgs().cancelUrl);
  assert.notEqual(fields.get("line_items[0][price_data][unit_amount]"), "1");
  assert.equal(fields.has("automatic_tax[enabled]"), false);
  assert.equal(fields.has("payment_intent_data[capture_method]"), false);
});

test("Checkout accepts a least-privilege restricted test key", async (t) => {
  let request;
  installFetchMock(t, async (input, init = {}) => {
    request = { url: new URL(input), init };
    return new Response(JSON.stringify({
      id: "cs_test_steadlanerestricted001",
      url: "https://checkout.stripe.com/c/pay/cs_test_steadlanerestricted001",
      status: "open",
      livemode: false,
      expires_at: Math.floor(Date.now() / 1000) + 1_800,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await createStripeCheckoutSession({ STRIPE_SECRET_KEY: RESTRICTED_KEY }, checkoutArgs());

  assert.equal(request.url.href, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(new Headers(request.init.headers).get("authorization"), `Bearer ${RESTRICTED_KEY}`);
});

test("Checkout refuses live-mode secret and restricted keys without contacting Stripe", async (t) => {
  let fetchCalls = 0;
  installFetchMock(t, async () => {
    fetchCalls += 1;
    throw new Error("A live-mode request must never be sent by this beta.");
  });

  for (const liveKey of ["sk_live_never_use", "rk_live_never_use"]) {
    await assert.rejects(() => createStripeCheckoutSession(
      { STRIPE_SECRET_KEY: liveKey },
      checkoutArgs(),
    ));
  }
  assert.equal(fetchCalls, 0);
});

test("Stripe Tax stays disabled by default and cannot be enabled without all setup gates", async (t) => {
  const requestBodies = [];
  installFetchMock(t, async (_input, init = {}) => {
    requestBodies.push(new URLSearchParams(init.body));
    return new Response(JSON.stringify({
      id: "cs_test_steadlanetaxgate",
      url: "https://checkout.stripe.com/c/pay/cs_test_steadlanetaxgate",
      status: "open",
      payment_status: "unpaid",
      livemode: false,
      expires_at: Math.floor(Date.now() / 1000) + 1_800,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await createStripeCheckoutSession({ STRIPE_SECRET_KEY: SECRET_KEY }, checkoutArgs());
  assert.equal(requestBodies[0].has("automatic_tax[enabled]"), false);

  await assert.rejects(() => createStripeCheckoutSession({
    STRIPE_SECRET_KEY: SECRET_KEY,
    STRIPE_AUTOMATIC_TAX_ENABLED: "true",
  }, checkoutArgs()));
  assert.equal(requestBodies.length, 1);
});

test("Stripe webhook verification accepts a fresh HMAC signature over the raw body", async () => {
  const event = {
    id: "evt_steadlanetest001",
    type: "checkout.session.completed",
    livemode: false,
    data: { object: { id: "cs_test_steadlane001" } },
  };
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const verified = await verifyStripeWebhook(
    rawBody,
    `t=${timestamp},v1=${signature}`,
    WEBHOOK_SECRET,
  );

  assert.deepEqual(verified, event);
});

test("Stripe webhook verification rejects forged, stale, and malformed signatures", async () => {
  const rawBody = JSON.stringify({ id: "evt_forged", type: "checkout.session.completed" });
  const nowMs = Date.now();
  const timestamp = Math.floor(nowMs / 1000);
  const forged = await verifyStripeWebhook(rawBody, `t=${timestamp},v1=${"0".repeat(64)}`, WEBHOOK_SECRET, nowMs);
  const staleTimestamp = timestamp - 600;
  const staleSignature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${staleTimestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const stale = await verifyStripeWebhook(
    rawBody,
    `t=${staleTimestamp},v1=${staleSignature}`,
    WEBHOOK_SECRET,
    nowMs,
  );
  const malformed = await verifyStripeWebhook(rawBody, "v1=not-a-timestamp", WEBHOOK_SECRET, nowMs);

  assert.equal(forged, null);
  assert.equal(stale, null);
  assert.equal(malformed, null);
});

test("refund events retain the greatest cumulative amount and derive status from it", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/20261115000200_steadlane_stripe_payments.sql", import.meta.url),
    "utf8",
  );
  const refundStart = migration.lastIndexOf("if p_event_type = 'charge.refunded' then");
  const refundEnd = migration.indexOf("\n  else\n    if p_payment_intent_id is not null", refundStart);
  assert.notEqual(refundStart, -1);
  assert.notEqual(refundEnd, -1);
  const refundBranch = migration.slice(refundStart, refundEnd);

  assert.match(
    refundBranch,
    /v_effective_refund_cents\s*:=\s*greatest\(v_attempt\.amount_refunded_cents,\s*p_amount_refunded_cents\)/i,
  );
  assert.match(refundBranch, /when v_effective_refund_cents = v_attempt\.amount_cents then 'refunded'/i);
  assert.match(refundBranch, /when v_effective_refund_cents > 0 then 'partially_refunded'/i);
  assert.match(refundBranch, /amount_refunded_cents\s*=\s*v_effective_refund_cents/i);
  assert.doesNotMatch(refundBranch, /amount_refunded_cents\s*=\s*p_amount_refunded_cents/i);
});

test("payment migration matches Checkout RPCs and leaves booking payment-method fields untouched", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/20261115000200_steadlane_stripe_payments.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /create or replace function public\.prepare_booking_checkout\(p_booking_id uuid\)/i);
  assert.match(migration, /create or replace function public\.record_booking_checkout_session\([\s\S]*?p_checkout_expires_at timestamptz\s*\)/i);
  assert.match(migration, /create or replace function public\.expire_booking_checkout_session\([\s\S]*?p_checkout_session_id text\s*\)/i);
  assert.match(migration, /create or replace function public\.process_stripe_webhook_event\([\s\S]*?p_payment_status text\s*\)/i);
  assert.match(migration, /grant select on table public\.booking_payment_attempts to authenticated/i);
  assert.match(migration, /using \(\(select auth\.uid\(\)\) = passenger_id\)/i);
  assert.match(migration, /booking\.status <> 'assigned'/i);
  assert.doesNotMatch(migration, /payment_method|payment_authorized_at|prepare_booking_capture|capture_failure|payment_received/i);
});

test("unlinked Checkout expiry is service-only and expires only an unlinked pending attempt", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/20261115000200_steadlane_stripe_payments.sql", import.meta.url),
    "utf8",
  );
  const functionStart = migration.indexOf(
    "create or replace function public.expire_unlinked_booking_checkout_attempt(p_payment_attempt_id uuid)",
  );
  assert.notEqual(functionStart, -1, "the migration must define the recovery RPC");
  const functionEnd = migration.indexOf("$function$;", functionStart);
  assert.notEqual(functionEnd, -1, "the recovery RPC must have a complete function body");
  const recoveryFunction = migration.slice(functionStart, functionEnd);

  assert.match(recoveryFunction, /for update/i);
  assert.match(recoveryFunction, /stripe_checkout_session_id is not null/i);
  assert.match(recoveryFunction, /checkout_url is not null/i);
  assert.match(recoveryFunction, /checkout_expires_at is not null/i);
  assert.match(recoveryFunction, /v_attempt\.status <> 'pending'/i);
  assert.match(recoveryFunction, /set status = 'expired'/i);
  assert.match(recoveryFunction, /'payment_status', 'expired'/i);
  assert.match(
    migration,
    /revoke all on function public\.expire_unlinked_booking_checkout_attempt\(uuid\) from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.expire_unlinked_booking_checkout_attempt\(uuid\) to service_role;/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.expire_unlinked_booking_checkout_attempt\(uuid\) to [^;]*\b(authenticated|anon|public)\b/i,
  );
});
