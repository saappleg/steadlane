import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createRouteMap } from "../src/map.js";
import worker from "../src/worker.js";

const SUPABASE_URL = "https://steadlane-test.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test_public_key";
const SUPABASE_SECRET_KEY = "sb_secret_test_server_key";
const GEOAPIFY_API_KEY = "geoapify_test_server_key";
const STRIPE_SECRET_KEY = "sk_test_steadlane_test_worker_key_001";
const STRIPE_RESTRICTED_KEY = "rk_test_steadlane_test_worker_key_001";
const STRIPE_WEBHOOK_SECRET = "whsec_steadlane_test_worker_secret_001";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const USER_TOKEN = `${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(30)}`;
const APP_ORIGIN = "https://steadlane.example";

function makeEnv(overrides = {}) {
  return {
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY,
    GEOAPIFY_API_KEY,
    ADDRESS_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ROUTE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    MAP_TILE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: {
      fetch() {
        throw new Error("Unexpected static asset request in Worker API test.");
      },
    },
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiRequest(path, { method = "GET", body, headers = {} } = {}) {
  const requestHeaders = new Headers({ origin: APP_ORIGIN, ...headers });
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  return new Request(`${APP_ORIGIN}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function installFetchMock(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

class RouteMapMockElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.classList = { add() {} };
    this.listeners = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  append(...elements) {
    this.children.push(...elements);
  }

  replaceChildren(...elements) {
    this.children = [...elements];
  }

  addEventListener(name, handler) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(handler);
    this.listeners.set(name, listeners);
  }

  remove() {
    this.removed = true;
  }

  getBoundingClientRect() {
    return { width: 640, height: 320 };
  }
}

function withRouteMapDom(devicePixelRatio, callback) {
  const previousGlobals = {
    HTMLElement: globalThis.HTMLElement,
    document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver,
    window: globalThis.window,
  };
  globalThis.HTMLElement = RouteMapMockElement;
  globalThis.document = {
    createElement: (tagName) => new RouteMapMockElement(tagName),
    createElementNS: (_namespace, tagName) => new RouteMapMockElement(tagName),
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.window = { devicePixelRatio, addEventListener() {}, removeEventListener() {} };

  try {
    return callback();
  } finally {
    for (const [name, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

async function assertRouteQuoteProviderFailure(t, {
  expectedCode,
  expectedMessage,
  expectedStatus,
  providerStatus,
  fetchError,
}) {
  let detailCalls = 0;
  let routeCalls = 0;
  const providerDetails = "Sensitive provider detail: fake-test-address at fake-test-coordinates; test-only-geoapify-key";
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v2/place-details") {
      detailCalls += 1;
      const pickup = url.searchParams.get("id") === "route-error-pickup-001";
      return jsonResponse({
        features: [{
          properties: pickup
            ? { feature_type: "details", place_id: "route-error-pickup-001", formatted: "Pickup, Cincinnati", lat: 39.1, lon: -84.5, country_code: "us", state_code: "OH" }
            : { feature_type: "details", place_id: "route-error-destination-002", formatted: "Destination, Cincinnati", lat: 39.2, lon: -84.4, country_code: "us", state_code: "OH" },
        }],
      });
    }
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v1/routing") {
      routeCalls += 1;
      if (fetchError) throw fetchError;
      return jsonResponse({
        statusCode: providerStatus,
        error: "Provider-only error",
        message: providerDetails,
      }, providerStatus);
    }
    assert.fail(`Unexpected request during route failure test: ${url.origin}${url.pathname}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/route-quote", {
      method: "POST",
      body: {
        pickup: { placeId: "route-error-pickup-001" },
        destination: { placeId: "route-error-destination-002" },
        pickupAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        passengerCount: 1,
      },
    }),
    makeEnv(),
  );
  const payload = await response.json();
  const publicBody = JSON.stringify(payload);

  assert.equal(detailCalls, 2);
  assert.equal(routeCalls, 1);
  assert.equal(response.status, expectedStatus);
  assert.deepEqual(payload, { error: { code: expectedCode, message: expectedMessage } });
  assert.doesNotMatch(publicBody, /test-only-geoapify-key|fake-test-address|fake-test-coordinates|Provider-only error|Sensitive provider detail/);
}

function signedStripeWebhookRequest(event) {
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return new Request(`${APP_ORIGIN}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: rawBody,
  });
}

function checkoutSessionWebhookEvent({ eventId, eventType, sessionId, paymentIntentId, paymentStatus }) {
  return {
    id: eventId,
    type: eventType,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: sessionId,
        metadata: {
          steadlane_booking_id: "22222222-2222-4222-8222-222222222222",
          steadlane_payment_attempt_id: "77777777-7777-4777-8777-777777777777",
        },
        payment_intent: paymentIntentId,
        amount_total: 2_800,
        currency: "usd",
        payment_status: paymentStatus,
      },
    },
  };
}

async function assertStripeWebhookForwarded(t, event, expectedFields, paymentStatus) {
  let forwardedBody;
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    assert.equal(url.origin, SUPABASE_URL);
    assert.equal(url.pathname, "/rest/v1/rpc/process_stripe_webhook_event");
    assert.equal(headers.get("apikey"), SUPABASE_SECRET_KEY);
    assert.equal(headers.has("authorization"), false);
    forwardedBody = JSON.parse(init.body);
    return jsonResponse({ duplicate: false, applied: true, payment_status: paymentStatus });
  });

  const response = await worker.fetch(
    signedStripeWebhookRequest(event),
    makeEnv({ STRIPE_WEBHOOK_SECRET, SUPABASE_SECRET_KEY }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { received: true, duplicate: false });
  assert.deepEqual(forwardedBody, expectedFields);
}

test("GET /api/config exposes only the public Supabase URL and publishable key", async () => {
  const response = await worker.fetch(apiRequest("/api/config"), makeEnv());
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    supabaseUrl: SUPABASE_URL,
    supabasePublishableKey: PUBLISHABLE_KEY,
    stripePaymentsEnabled: false,
  });
  assert.equal(JSON.stringify(payload).includes(SUPABASE_SECRET_KEY), false);
  assert.equal(JSON.stringify(payload).includes(GEOAPIFY_API_KEY), false);

  const paymentsReady = await worker.fetch(apiRequest("/api/config"), makeEnv({
    STRIPE_PAYMENTS_ENABLED: "true",
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
  }));
  assert.equal((await paymentsReady.json()).stripePaymentsEnabled, true);

  const restrictedPaymentsReady = await worker.fetch(apiRequest("/api/config"), makeEnv({
    STRIPE_PAYMENTS_ENABLED: "true",
    STRIPE_SECRET_KEY: STRIPE_RESTRICTED_KEY,
    STRIPE_WEBHOOK_SECRET,
  }));
  assert.equal((await restrictedPaymentsReady.json()).stripePaymentsEnabled, true);

  for (const liveKey of ["sk_live_steadlane_test_worker_key_001", "rk_live_steadlane_test_worker_key_001"]) {
    const livePayments = await worker.fetch(apiRequest("/api/config"), makeEnv({
      STRIPE_PAYMENTS_ENABLED: "true",
      STRIPE_SECRET_KEY: liveKey,
      STRIPE_WEBHOOK_SECRET,
    }));
    assert.equal((await livePayments.json()).stripePaymentsEnabled, false);
  }

  const taxEnabled = await worker.fetch(apiRequest("/api/config"), makeEnv({
    STRIPE_PAYMENTS_ENABLED: "true",
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    STRIPE_AUTOMATIC_TAX_ENABLED: "true",
  }));
  assert.equal((await taxEnabled.json()).stripePaymentsEnabled, false);
});

test("GET /api/rates reports the known schedule and leaves stop pricing unset", async () => {
  const response = await worker.fetch(
    apiRequest("/api/rates"),
    makeEnv({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_SECRET_KEY: undefined }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    currency: "USD",
    provisional: true,
    rates: {
      baseFare: 3,
      perMile: 1.8,
      perMinute: 0.3,
      minimumFare: 8,
      bookingFee: 1,
      stopFeePerStop: null,
    },
  });
  const pricedStopResponse = await worker.fetch(
    apiRequest("/api/rates"),
    makeEnv({ STOP_FEE_CENTS: "275" }),
  );
  const pricedStopPayload = await pricedStopResponse.json();
  assert.equal(pricedStopPayload.rates.stopFeePerStop, 2.75);
});

test("route map requests @2x tiles for high-density displays without changing tile coverage", () => {
  const route = {
    type: "LineString",
    coordinates: [[-84.512, 39.103], [-84.51, 39.08]],
  };
  const renderTiles = (devicePixelRatio) => withRouteMapDom(devicePixelRatio, () => {
    const container = new RouteMapMockElement("div");
    const map = createRouteMap(container);
    map.setRoute(route);
    const tiles = container.children[0].children[0].children;
    return tiles.map((tile) => ({ src: tile.src, width: tile.style.width, height: tile.style.height }));
  });

  const standardTiles = renderTiles(1);
  const retinaTiles = renderTiles(2);

  assert.ok(standardTiles.length > 0);
  assert.deepEqual(
    retinaTiles.map(({ src, width, height }) => ({ src, width, height })),
    standardTiles.map(({ src, width, height }) => ({ src: src.replace(/\.png$/, "@2x.png"), width, height })),
  );
  assert.ok(standardTiles.every(({ src, width, height }) => src.endsWith(".png") && !src.endsWith("@2x.png") && width === "256px" && height === "256px"));
  assert.ok(retinaTiles.every(({ src, width, height }) => src.endsWith("@2x.png") && width === "256px" && height === "256px"));
});

test("service worker v6 precaches the map module, retires v5, and bypasses API caching", async () => {
  const listeners = new Map();
  const openedCacheNames = [];
  const shellPaths = [];
  const deletedCacheNames = [];
  let cacheMatchCalls = 0;
  const cache = {
    addAll(paths) {
      shellPaths.push(...Array.from(paths));
      return Promise.resolve();
    },
    put() {
      return Promise.resolve();
    },
  };
  const cacheStorage = {
    open(name) {
      openedCacheNames.push(name);
      return Promise.resolve(cache);
    },
    match() {
      cacheMatchCalls += 1;
      return Promise.resolve(null);
    },
    keys() {
      return Promise.resolve(["steadlane-shell-v5", "unrelated-cache"]);
    },
    delete(name) {
      deletedCacheNames.push(name);
      return Promise.resolve(true);
    },
  };
  const selfMock = {
    location: { origin: APP_ORIGIN },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    skipWaiting() {
      return Promise.resolve();
    },
    clients: {
      claim() {
        return Promise.resolve();
      },
    },
  };
  const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  runInNewContext(source, { self: selfMock, caches: cacheStorage, URL, Promise, fetch });

  let installPromise;
  listeners.get("install")({ waitUntil(promise) { installPromise = promise; } });
  await installPromise;

  assert.deepEqual(openedCacheNames, ["steadlane-shell-v6"]);
  assert.ok(shellPaths.includes("/src/map.js"));
  assert.ok(shellPaths.includes("/src/app.js?v=5"));

  let activatePromise;
  listeners.get("activate")({ waitUntil(promise) { activatePromise = promise; } });
  await activatePromise;
  assert.deepEqual(deletedCacheNames, ["steadlane-shell-v5"]);

  let respondWithCalls = 0;
  for (const path of ["/api/config", "/api/map/3/2/4@2x.png"]) {
    listeners.get("fetch")({
      request: new Request(`${APP_ORIGIN}${path}`),
      respondWith() { respondWithCalls += 1; },
    });
  }
  assert.equal(respondWithCalls, 0);
  assert.equal(cacheMatchCalls, 0);
});

test("API requests reject a mismatched origin before doing upstream work", async (t) => {
  let upstreamCalls = 0;
  installFetchMock(t, async () => {
    upstreamCalls += 1;
    throw new Error("The mocked fetch should not run for a cross-origin request.");
  });

  const request = new Request(`${APP_ORIGIN}/api/config`, {
    headers: { origin: "https://another-site.example" },
  });
  const response = await worker.fetch(request, makeEnv());
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.error.code, "origin_not_allowed");
  assert.equal(upstreamCalls, 0);
});

test("protected API routes reject missing authentication without contacting services", async (t) => {
  let upstreamCalls = 0;
  installFetchMock(t, async () => {
    upstreamCalls += 1;
    throw new Error("Unauthenticated requests must not reach an upstream service.");
  });

  const response = await worker.fetch(apiRequest("/api/me"), makeEnv());
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.error.code, "sign_in_required");
  assert.equal(upstreamCalls, 0);
});

test("route quotes use provider metrics and server rates, then store the trusted snapshot", async (t) => {
  const calls = [];
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ url, method, headers, body: init.body });

    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      assert.equal(method, "GET");
      assert.equal(headers.get("apikey"), PUBLISHABLE_KEY);
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }

    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      assert.equal(method, "GET");
      assert.equal(headers.get("apikey"), PUBLISHABLE_KEY);
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      return jsonResponse([{
        id: USER_ID,
        role: "passenger",
        full_name: "Passenger Example",
        phone: "+1 555 0100",
      }]);
    }

    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v2/place-details") {
      assert.equal(url.searchParams.get("apiKey"), GEOAPIFY_API_KEY);
      assert.equal(headers.has("authorization"), false);
      const placeId = url.searchParams.get("id");
      const pickup = placeId === "pickup-place-001";
      return jsonResponse({
        features: [
          {
            properties: {
              feature_type: "drive_10",
              place_id: "unrelated-route-feature-099",
              formatted: "Do not use this route feature",
              lat: 35,
              lon: -80,
            },
          },
          {
            properties: pickup
              ? { feature_type: "details", place_id: "canonical-pickup-001", formatted: "Canonical Pickup, Cincinnati", lat: 39.1, lon: -84.5, country_code: "us", state_code: "OH" }
              : { feature_type: "details", place_id: "canonical-destination-002", formatted: "Canonical Destination, Cincinnati", lat: 39.2, lon: -84.4, country_code: "us", state_code: "OH" },
          },
        ],
      });
    }

    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v1/routing") {
      assert.equal(url.searchParams.get("apiKey"), GEOAPIFY_API_KEY);
      assert.equal(url.searchParams.get("waypoints"), "39.1,-84.5|39.2,-84.4");
      assert.equal(headers.has("authorization"), false);
      return jsonResponse({
        features: [{
          properties: { distance: 16_093.44, time: 1_200 },
          geometry: {
            type: "LineString",
            coordinates: [[-84.5, 39.1], [-84.45, 39.15], [-84.4, 39.2]],
          },
        }],
      });
    }

    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/ride_quotes") {
      assert.equal(method, "POST");
      assert.equal(headers.get("apikey"), SUPABASE_SECRET_KEY);
      assert.equal(headers.has("authorization"), false);
      return new Response(null, { status: 201 });
    }

    assert.fail(`Unexpected mocked request: ${method} ${url.href}`);
  });

  const request = apiRequest("/api/route-quote", {
    method: "POST",
    headers: { authorization: `Bearer ${USER_TOKEN}` },
    body: {
      pickup: {
        placeId: "pickup-place-001",
        label: "Client supplied fake pickup",
        lat: 1,
        lon: 2,
      },
      destination: {
        placeId: "destination-place-002",
        label: "Client supplied fake destination",
        lat: 3,
        lon: 4,
      },
      pickupAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      passengerCount: 2,
      distanceMiles: 0.1,
      durationMinutes: 1,
      fare: 0,
    },
  });

  const response = await worker.fetch(request, makeEnv());
  const payload = await response.json();
  const quoteInsert = calls.find((call) => call.url.pathname === "/rest/v1/ride_quotes");
  const storedQuote = JSON.parse(quoteInsert.body);

  assert.equal(response.status, 201);
  assert.equal(payload.quote.route.distanceMiles, 10);
  assert.equal(payload.quote.route.durationMinutes, 20);
  assert.deepEqual(payload.quote.route.geometry, {
    type: "LineString",
    coordinates: [[-84.5, 39.1], [-84.45, 39.15], [-84.4, 39.2]],
  });
  assert.deepEqual(payload.quote.fare, {
    baseFare: 3,
    distanceCharge: 18,
    durationCharge: 6,
    minimumAdjustment: 0,
    bookingFee: 1,
    stopCount: 0,
    stopCharge: 0,
    knownSubtotal: 28,
    bookable: true,
    total: 28,
  });
  assert.equal(payload.quote.bookingEligible, true);
  assert.equal(storedQuote.passenger_id, USER_ID);
  assert.equal(storedQuote.pickup_label, "Canonical Pickup, Cincinnati");
  assert.equal(storedQuote.destination_label, "Canonical Destination, Cincinnati");
  assert.equal(storedQuote.fare_total_cents, 2_800);
  assert.equal(storedQuote.distance_miles, 10);
  assert.equal(storedQuote.duration_minutes, 20);
  assert.equal(storedQuote.provisional, true);
  assert.equal(storedQuote.route_geometry.type, "LineString");
  assert.equal(calls.filter((call) => call.url.origin === "https://api.geoapify.com").length, 3);
  assert.equal(calls.filter((call) => call.url.pathname === "/rest/v1/ride_quotes").length, 1);
});

test("anonymous route estimates work without Supabase and never persist a quote", async (t) => {
  const calls = [];
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v2/place-details") {
      const pickup = url.searchParams.get("id") === "guest-pickup-001";
      return jsonResponse({
        features: [{
          properties: pickup
            ? { feature_type: "details", place_id: "guest-pickup-001", formatted: "Guest pickup, Cincinnati", lat: 39.1, lon: -84.5, country_code: "us", state_code: "OH" }
            : { feature_type: "details", place_id: "guest-destination-002", formatted: "Guest destination, Cincinnati", lat: 39.2, lon: -84.4, country_code: "us", state_code: "OH" },
        }],
      });
    }
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v1/routing") {
      return jsonResponse({
        features: [{
          properties: { distance: 1_609.344, time: 60 },
          geometry: { type: "LineString", coordinates: [[-84.5, 39.1], [-84.4, 39.2]] },
        }],
      });
    }
    assert.fail(`Anonymous estimates must not call Supabase: ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/route-quote", {
      method: "POST",
      body: {
        pickup: { placeId: "guest-pickup-001" },
        destination: { placeId: "guest-destination-002" },
        pickupAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        passengerCount: 1,
      },
    }),
    makeEnv({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_SECRET_KEY: undefined }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.quote.id, null);
  assert.equal(payload.quote.expiresAt, null);
  assert.equal(payload.quote.bookingEligible, false);
  assert.equal(payload.quote.fare.bookable, true);
  assert.equal(payload.quote.fare.total, 9);
  assert.equal(calls.length, 3);
  assert.equal(calls.some((url) => url.origin === SUPABASE_URL), false);
});

test("multi-stop route estimates preserve stops, flatten route legs, and remain unbookable without a stop fee", async (t) => {
  const calls = [];
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v2/place-details") {
      const placeId = url.searchParams.get("id");
      const places = {
        "guest-pickup-001": { formatted: "Pickup, Cincinnati", lat: 39.1, lon: -84.5, country_code: "us", state_code: "OH" },
        "middle-stop-002": { formatted: "Stop, Covington", lat: 39.09, lon: -84.51, country_code: "us", state_code: "US-KY" },
        "guest-destination-003": { formatted: "Destination, Lawrenceburg", lat: 39.09, lon: -84.86, country_code: "us", state_code: "IN" },
      };
      const returnedPlaceId = placeId === "middle-stop-002" ? "canonical-middle-stop-002" : placeId;
      return jsonResponse({ features: [{ properties: { feature_type: "details", place_id: returnedPlaceId, ...places[placeId] } }] });
    }
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v1/routing") {
      assert.equal(url.searchParams.get("waypoints"), "39.1,-84.5|39.09,-84.51|39.09,-84.86");
      assert.equal(url.searchParams.get("intermediate_waypoint_mode"), "stopover");
      return jsonResponse({
        features: [{
          properties: { distance: 16_093.44, time: 1_200 },
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [[-84.5, 39.1], [-84.51, 39.09]],
              [[-84.51, 39.09], [-84.86, 39.09]],
            ],
          },
        }],
      });
    }
    assert.fail(`Unpriced public stop estimates must not persist in Supabase: ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/route-quote", {
      method: "POST",
      body: {
        pickup: { placeId: "guest-pickup-001" },
        stops: [{ placeId: "middle-stop-002" }],
        destination: { placeId: "guest-destination-003" },
        pickupAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        passengerCount: 1,
      },
    }),
    makeEnv({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_SECRET_KEY: undefined }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.quote.stops.length, 1);
  assert.equal(payload.quote.stops[0].placeId, "canonical-middle-stop-002");
  assert.equal(payload.quote.route.geometry.type, "LineString");
  assert.deepEqual(payload.quote.route.geometry.coordinates, [
    [-84.5, 39.1],
    [-84.51, 39.09],
    [-84.86, 39.09],
  ]);
  assert.equal(payload.quote.fare.stopCount, 1);
  assert.equal(payload.quote.fare.stopCharge, null);
  assert.equal(payload.quote.fare.knownSubtotal, 28);
  assert.equal(payload.quote.fare.bookable, false);
  assert.equal(payload.quote.fare.total, null);
  assert.equal(payload.quote.bookingEligible, false);
  assert.equal(calls.length, 4);
});

test("route provider network and timeout failures return a safe retry message", async (t) => {
  await t.test("network failure", async (subtest) => {
    await assertRouteQuoteProviderFailure(subtest, {
      expectedCode: "maps_network_error",
      expectedMessage: "The address or route service could not be reached. Try again shortly.",
      expectedStatus: 502,
      fetchError: new TypeError("Network error for test-only-geoapify-key at fake-test-coordinates"),
    });
  });

  await t.test("timeout", async (subtest) => {
    const timeoutError = new Error("Timeout for fake-test-address using test-only-geoapify-key");
    timeoutError.name = "TimeoutError";
    await assertRouteQuoteProviderFailure(subtest, {
      expectedCode: "maps_network_error",
      expectedMessage: "The address or route service could not be reached. Try again shortly.",
      expectedStatus: 502,
      fetchError: timeoutError,
    });
  });
});

test("route provider status errors are classified without exposing provider details", async (t) => {
  const cases = [
    {
      name: "400 unreachable route",
      providerStatus: 400,
      expectedCode: "route_unavailable",
      expectedMessage: "A drivable route could not be found between these addresses. Check the selected addresses and try again.",
      expectedStatus: 422,
    },
    {
      name: "401 invalid configuration",
      providerStatus: 401,
      expectedCode: "maps_configuration_rejected",
      expectedMessage: "Address and route estimates are unavailable right now. Try again later.",
      expectedStatus: 503,
    },
    {
      name: "403 rejected configuration",
      providerStatus: 403,
      expectedCode: "maps_configuration_rejected",
      expectedMessage: "Address and route estimates are unavailable right now. Try again later.",
      expectedStatus: 503,
    },
    {
      name: "429 quota response",
      providerStatus: 429,
      expectedCode: "maps_busy",
      expectedMessage: "The address or route service is busy. Try again shortly.",
      expectedStatus: 503,
    },
    {
      name: "500 provider failure",
      providerStatus: 500,
      expectedCode: "maps_provider_unavailable",
      expectedMessage: "The address or route service is temporarily unavailable. Try again shortly.",
      expectedStatus: 502,
    },
  ];

  for (const failure of cases) {
    await t.test(failure.name, async (subtest) => {
      await assertRouteQuoteProviderFailure(subtest, failure);
    });
  }
});

test("address provider HTTP 400 returns a safe request-rejected response", async (t) => {
  const providerDetails = "Sensitive provider detail: Sample Provider Address at fake-test-coordinates; test-only-geoapify-key";
  let providerCalls = 0;
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    providerCalls += 1;
    assert.equal(url.origin, "https://api.geoapify.com");
    assert.equal(url.pathname, "/v1/geocode/search");
    assert.equal(url.searchParams.get("text"), "Sample Provider Address");
    return jsonResponse({
      statusCode: 400,
      error: "Provider-only error",
      message: providerDetails,
    }, 400);
  });

  const response = await worker.fetch(
    apiRequest("/api/address?q=Sample%20Provider%20Address&mode=full"),
    makeEnv({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_SECRET_KEY: undefined }),
  );
  const payload = await response.json();
  const publicBody = JSON.stringify(payload);

  assert.equal(providerCalls, 1);
  assert.equal(response.status, 422);
  assert.deepEqual(payload, {
    error: {
      code: "maps_request_rejected",
      message: "The address request could not be completed. Check the address and try again.",
    },
  });
  assert.doesNotMatch(publicBody, /test-only-geoapify-key|fake-test-coordinates|Provider-only error|Sensitive provider detail/);
});

test("public address autocomplete filters to Ohio, Kentucky, and Indiana without Supabase config", async (t) => {
  const requests = [];
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v1/geocode/autocomplete") {
      requests.push(url.pathname);
      const filter = url.searchParams.get("filter") || "";
      assert.equal(filter, "rect:-90,36,-80,42.2|countrycode:us");
      assert.equal(url.searchParams.get("bias"), null);
      assert.equal(url.searchParams.get("format"), "geojson");
      assert.equal(url.searchParams.get("limit"), "20");
      assert.equal(url.searchParams.get("apiKey"), GEOAPIFY_API_KEY);
      assert.equal(headers.has("authorization"), false);
      return jsonResponse({
        features: [
          { properties: { place_id: "illinois-result-001", formatted: "Chicago, IL", lat: 41.88, lon: -87.63, country_code: "us", state_code: "IL" } },
          { properties: { place_id: "west-virginia-result-002", formatted: "Wheeling, WV", lat: 40.064, lon: -80.721, country_code: "us", state_code: "WV" } },
          { properties: { place_id: "tennessee-result-003", formatted: "Nashville, TN", lat: 36.163, lon: -86.782, country_code: "us", state_code: "TN" } },
          { properties: { place_id: "michigan-result-004", formatted: "Detroit, MI", lat: 42.331, lon: -83.046, country_code: "us", state_code: "MI" } },
          { properties: { place_id: "virginia-result-005", formatted: "Bristol, VA", lat: 36.596, lon: -82.188, country_code: "us", state_code: "VA" } },
          { properties: { place_id: "pennsylvania-result-006", formatted: "Erie, PA", lat: 42.129, lon: -80.085, country_code: "us", state_code: "PA" } },
          { properties: { place_id: "ohio-result-001", formatted: "Cincinnati, OH", lat: 39.1, lon: -84.5, country_code: "us", state_code: "OH" } },
          { properties: { place_id: "kentucky-result-002", formatted: "Louisville, KY", lat: 38.25, lon: -85.75, country_code: "us", state_code: "US-KY" } },
          { properties: { place_id: "indiana-result-003", formatted: "Indianapolis, IN", lat: 39.77, lon: -86.16, country_code: "us", state_code: "Indiana" } },
          { properties: { place_id: "western-kentucky-result-004", formatted: "Paducah, KY", lat: 37.083, lon: -88.6, country_code: "us", state_code: "KY" } },
          { properties: { place_id: "southern-kentucky-result-005", formatted: "South Fulton, KY", lat: 36.50, lon: -88.87, country_code: "us", state_code: "KY" } },
          { properties: { place_id: "eastern-ohio-result-006", formatted: "East Liverpool, OH", lat: 40.63, lon: -80.57, country_code: "us", state_code: "OH" } },
          { properties: { place_id: "missing-state-result-007", formatted: "Unverified address", lat: 39.1, lon: -84.5, country_code: "us" } },
        ],
      });
    }
    assert.fail(`Unexpected mocked request: ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/address?q=Cincinnati"),
    makeEnv({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_SECRET_KEY: undefined }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.suggestions.map(({ placeId }) => placeId), [
    "ohio-result-001",
    "kentucky-result-002",
    "indiana-result-003",
    "western-kentucky-result-004",
    "southern-kentucky-result-005",
    "eastern-ohio-result-006",
  ]);
  assert.deepEqual(requests, ["/v1/geocode/autocomplete"]);
  for (const suggestion of payload.suggestions) {
    assert.ok(suggestion.lat >= 36 && suggestion.lat <= 42.2);
    assert.ok(suggestion.lon >= -90 && suggestion.lon <= -80);
  }
});

test("an empty autocomplete does not make a second provider request while the passenger is typing", async (t) => {
  const requests = [];
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    requests.push(url.pathname);
    assert.equal(url.pathname, "/v1/geocode/autocomplete");
    return jsonResponse({ features: [] });
  });

  const response = await worker.fetch(
    apiRequest("/api/address?q=No%20Matching%20Test%20Address"),
    makeEnv({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_SECRET_KEY: undefined }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.suggestions, []);
  assert.deepEqual(requests, ["/v1/geocode/autocomplete"]);
});

test("explicit full address search uses Geoapify geocoding and keeps the state filter", async (t) => {
  const requests = [];
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    requests.push(url);
    assert.equal(url.origin, "https://api.geoapify.com");
    assert.equal(url.searchParams.get("text"), "Sample Test Address");
    assert.equal(url.pathname, "/v1/geocode/search");
    assert.equal(url.searchParams.get("filter"), "rect:-90,36,-80,42.2|countrycode:us");
    assert.equal(url.searchParams.get("format"), "geojson");
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(url.searchParams.get("apiKey"), GEOAPIFY_API_KEY);
    return jsonResponse({
      features: [
        {
          properties: {
            place_id: "sample-test-address-result-001",
            formatted: "Sample Test Address, Ohio, United States",
            lat: 39.1,
            lon: -84.5,
            country_code: "us",
            state: "Ohio",
          },
        },
        {
          properties: {
            place_id: "outside-service-area-result-001",
            formatted: "Sample Test Address, Pennsylvania, United States",
            lat: 41.9,
            lon: -77.7,
            country_code: "us",
            state_code: "PA",
          },
        },
      ],
    });
  });

  const response = await worker.fetch(
    apiRequest("/api/address?q=Sample%20Test%20Address&mode=full"),
    makeEnv({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_SECRET_KEY: undefined }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.suggestions, [
    {
      placeId: "sample-test-address-result-001",
      label: "Sample Test Address, Ohio, United States",
      lat: 39.1,
      lon: -84.5,
    },
  ]);
  assert.deepEqual(requests.map((url) => url.pathname), ["/v1/geocode/search"]);
});

test("driver availability reads and saves normalized weekly windows through the caller token", async (t) => {
  const calls = [];
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ url, method, headers, body: init.body });
    assert.equal(headers.get("apikey"), PUBLISHABLE_KEY);
    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "driver@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{ id: USER_ID, role: "driver" }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/driver_weekly_availability") {
      assert.equal(method, "GET");
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      return jsonResponse([
        { day_of_week: 1, start_time: "08:30:00", end_time: "12:00:00" },
        { day_of_week: 5, start_time: "13:15:00", end_time: "18:00:00" },
      ]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/set_driver_availability") {
      assert.equal(method, "POST");
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      assert.deepEqual(JSON.parse(init.body), {
        p_availability: [
          { day_of_week: 2, start_time: "09:00", end_time: "12:30" },
          { day_of_week: 6, start_time: "10:15", end_time: "16:45" },
        ],
      });
      return new Response(null, { status: 204 });
    }
    assert.fail(`Unexpected mocked request: ${method} ${url.href}`);
  });

  const getResponse = await worker.fetch(
    apiRequest("/api/driver/availability", { headers: { authorization: `Bearer ${USER_TOKEN}` } }),
    makeEnv(),
  );
  const getPayload = await getResponse.json();
  assert.equal(getResponse.status, 200);
  assert.deepEqual(getPayload, {
    availability: [
      { dayOfWeek: 1, startTime: "08:30", endTime: "12:00" },
      { dayOfWeek: 5, startTime: "13:15", endTime: "18:00" },
    ],
  });

  const saveResponse = await worker.fetch(
    apiRequest("/api/driver/availability", {
      method: "PUT",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: {
        availability: [
          { dayOfWeek: 6, startTime: "10:15", endTime: "16:45" },
          { dayOfWeek: 2, startTime: "09:00", endTime: "12:30" },
        ],
      },
    }),
    makeEnv(),
  );
  const savePayload = await saveResponse.json();
  assert.equal(saveResponse.status, 200);
  assert.deepEqual(savePayload, {
    availability: [
      { dayOfWeek: 2, startTime: "09:00", endTime: "12:30" },
      { dayOfWeek: 6, startTime: "10:15", endTime: "16:45" },
    ],
  });
  assert.equal(calls.length, 6);
});

test("recurring booking validates and stores a New York weekly schedule with contact snapshots", async (t) => {
  const calls = [];
  const bookingId = "22222222-2222-4222-8222-222222222222";
  const quoteId = "33333333-3333-4333-8333-333333333333";
  const idempotencyKey = "44444444-4444-4444-8444-444444444444";
  const seriesId = "55555555-5555-4555-8555-555555555555";
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ url, method, headers, body: init.body });
    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{
        id: USER_ID,
        role: "passenger",
        full_name: "Passenger Example",
        phone: "+1 555 0100",
      }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/create_recurring_bookings_from_quote") {
      assert.equal(method, "POST");
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      assert.deepEqual(JSON.parse(init.body), {
        p_quote_id: quoteId,
        p_idempotency_key: idempotencyKey,
        p_weekdays: [1, 3],
        p_start_date: "2027-01-04",
        p_end_date: "2027-01-20",
        p_pickup_time: "10:30",
      });
      return jsonResponse({
        series: {
          id: seriesId,
          status: "active",
          weekdays: [1, 3],
          start_date: "2027-01-04",
          end_date: "2027-01-20",
          pickup_time: "10:30:00",
          time_zone: "America/New_York",
        },
        bookings: [{
          id: bookingId,
          recurring_series_id: seriesId,
          status: "pending",
          pickup_label: "Pickup, Cincinnati",
          destination_label: "Destination, Cincinnati",
          stops: [{ place_id: "stop-001", label: "Stop, Cincinnati", latitude: 39.15, longitude: -84.45 }],
          stop_count: 1,
          fare_stop_cents: 275,
          fare_total_cents: 3_075,
        }],
      });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/booking_contacts") {
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      assert.equal(url.searchParams.get("booking_id"), `in.(${bookingId})`);
      return jsonResponse([{
        booking_id: bookingId,
        passenger_name: "Passenger Example",
        passenger_phone: "+1 555 0100",
      }]);
    }
    assert.fail(`Unexpected mocked request: ${method} ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/recurring-bookings", {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: {
        quoteId,
        idempotencyKey,
        weekdays: [3, 1],
        startDate: "2027-01-04",
        endDate: "2027-01-20",
        pickupTime: "10:30",
      },
    }),
    makeEnv(),
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.series.id, seriesId);
  assert.equal(payload.bookings.length, 1);
  assert.equal(payload.bookings[0].recurring_series_id, seriesId);
  assert.equal(payload.bookings[0].stops[0].label, "Stop, Cincinnati");
  assert.equal(payload.bookings[0].passenger_name, "Passenger Example");
  assert.equal(calls.length, 4);
});

test("passengers can cancel a recurring series through the authorized RPC", async (t) => {
  const seriesId = "66666666-6666-4666-8666-666666666666";
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{ id: USER_ID, role: "passenger" }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/cancel_recurring_booking_series") {
      assert.equal(method, "POST");
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      assert.deepEqual(JSON.parse(init.body), { p_series_id: seriesId });
      return jsonResponse({ id: seriesId, status: "cancelled", cancelled_at: "2027-01-01T15:00:00Z" });
    }
    assert.fail(`Unexpected mocked request: ${method} ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest(`/api/recurring-bookings/${seriesId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: {},
    }),
    makeEnv(),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    series: { id: seriesId, status: "cancelled", cancelled_at: "2027-01-01T15:00:00Z" },
  });
});

test("public address, route, and map endpoints enforce their IP limiters", async (t) => {
  let upstreamCalls = 0;
  installFetchMock(t, async () => {
    upstreamCalls += 1;
    throw new Error("Rate-limited public requests must not reach a provider.");
  });
  const keys = { address: [], route: [], map: [] };
  const blockedLimiter = (received) => ({
    limit: async ({ key }) => {
      received.push(key);
      return { success: false };
    },
  });
  const env = makeEnv({
    ADDRESS_RATE_LIMITER: blockedLimiter(keys.address),
    ROUTE_RATE_LIMITER: blockedLimiter(keys.route),
    MAP_TILE_RATE_LIMITER: blockedLimiter(keys.map),
  });
  const requests = [
    apiRequest("/api/address?q=Cincinnati", { headers: { "cf-connecting-ip": "203.0.113.8" } }),
    apiRequest("/api/route-quote", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.8" }, body: {} }),
    apiRequest("/api/map/10/1/1.png", { headers: { "cf-connecting-ip": "203.0.113.8" } }),
  ];

  for (const request of requests) {
    const response = await worker.fetch(request, env);
    const payload = await response.json();
    assert.equal(response.status, 429);
    assert.equal(payload.error.code, "rate_limit_exceeded");
  }
  assert.deepEqual(keys, {
    address: ["ip:203.0.113.8"],
    route: ["ip:203.0.113.8"],
    map: ["ip:203.0.113.8"],
  });
  assert.equal(upstreamCalls, 0);
});

test("map tile proxy forwards standard and validated @2x Geoapify tile URLs", async (t) => {
  const upstreamPaths = [];
  const rateLimitKeys = [];
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://maps.geoapify.com");
    assert.equal(url.pathname.startsWith("/v1/tile/osm-bright/"), true);
    assert.equal(url.searchParams.get("apiKey"), GEOAPIFY_API_KEY);
    upstreamPaths.push(url.pathname);
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "content-type": "image/png" },
    });
  });
  const env = makeEnv({
    MAP_TILE_RATE_LIMITER: {
      limit: async ({ key }) => {
        rateLimitKeys.push(key);
        return { success: true };
      },
    },
  });

  const standardResponse = await worker.fetch(apiRequest("/api/map/3/2/4.png"), env);
  const retinaResponse = await worker.fetch(apiRequest("/api/map/3/2/4@2x.png"), env);
  const unsupportedScaleResponse = await worker.fetch(apiRequest("/api/map/3/2/4@3x.png"), env);
  const unsupportedScalePayload = await unsupportedScaleResponse.json();

  assert.equal(standardResponse.status, 200);
  assert.equal(standardResponse.headers.get("content-type"), "image/png");
  assert.equal(retinaResponse.status, 200);
  assert.equal(retinaResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(upstreamPaths, [
    "/v1/tile/osm-bright/3/2/4.png",
    "/v1/tile/osm-bright/3/2/4@2x.png",
  ]);
  assert.equal(unsupportedScaleResponse.status, 400);
  assert.equal(unsupportedScalePayload.error.code, "invalid_tile");
  assert.deepEqual(rateLimitKeys, ["ip:unknown", "ip:unknown", "ip:unknown"]);
});

test("route quotes reject canonical addresses outside Ohio, Kentucky, and Indiana", async (t) => {
  let routeCalls = 0;
  let quoteWrites = 0;
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{
        id: USER_ID,
        role: "passenger",
        full_name: "Passenger Example",
        phone: "+1 555 0100",
      }]);
    }
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v2/place-details") {
      const pickup = url.searchParams.get("id") === "outside-place-001";
      return jsonResponse({
        features: [{
          properties: pickup
            ? { feature_type: "details", place_id: "outside-place-001", formatted: "Chicago, IL", lat: 41.88, lon: -87.63, country_code: "us", state_code: "IL" }
            : { feature_type: "details", place_id: "inside-place-002", formatted: "Cincinnati, OH", lat: 39.2, lon: -84.4, country_code: "us", state_code: "OH" },
        }],
      });
    }
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v1/routing") {
      routeCalls += 1;
      return jsonResponse({ features: [] });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/ride_quotes") {
      quoteWrites += 1;
      return new Response(null, { status: 201 });
    }
    assert.fail(`Unexpected mocked request: ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/route-quote", {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: {
        pickup: { placeId: "outside-place-001" },
        destination: { placeId: "inside-place-002" },
        pickupAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        passengerCount: 1,
      },
    }),
    makeEnv(),
  );
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.equal(payload.error.code, "outside_service_area");
  assert.equal(routeCalls, 0);
  assert.equal(quoteWrites, 0);
});

test("booking creation accepts the current passenger request without a payment method", async (t) => {
  const bookingId = "22222222-2222-4222-8222-222222222222";
  const quoteId = "33333333-3333-4333-8333-333333333333";
  const idempotencyKey = "44444444-4444-4444-8444-444444444444";
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{ id: USER_ID, role: "passenger" }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/create_booking_from_quote") {
      assert.equal(method, "POST");
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      assert.deepEqual(JSON.parse(init.body), {
        p_quote_id: quoteId,
        p_idempotency_key: idempotencyKey,
      });
      return jsonResponse({ id: bookingId, status: "pending" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/booking_contacts") {
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      return jsonResponse([{ booking_id: bookingId, passenger_name: "Passenger Example", passenger_phone: "+1 555 0100" }]);
    }
    assert.fail(`Unexpected mocked request: ${method} ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/bookings", {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: { quoteId, idempotencyKey },
    }),
    makeEnv(),
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.booking.id, bookingId);
  assert.equal(payload.booking.passenger_phone, "+1 555 0100");
});

test("passenger ride history includes only the latest RLS-visible payment status", async (t) => {
  const firstBookingId = "22222222-2222-4222-8222-222222222222";
  const secondBookingId = "33333333-3333-4333-8333-333333333333";
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{ id: USER_ID, role: "passenger" }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/bookings") {
      return jsonResponse([{ id: firstBookingId, status: "assigned" }, { id: secondBookingId, status: "pending" }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/booking_contacts") {
      return jsonResponse([]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/booking_payment_attempts") {
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      assert.equal(url.searchParams.get("order"), "attempt_number.desc");
      return jsonResponse([
        { booking_id: firstBookingId, status: "failed", attempt_number: 2 },
        { booking_id: secondBookingId, status: "paid", attempt_number: 1 },
        { booking_id: firstBookingId, status: "expired", attempt_number: 1 },
      ]);
    }
    assert.fail(`Unexpected mocked request: ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/bookings?limit=50", { headers: { authorization: `Bearer ${USER_TOKEN}` } }),
    makeEnv({ STRIPE_PAYMENTS_ENABLED: "true", STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.bookings.map(({ id, payment_status: status }) => ({ id, status })), [
    { id: firstBookingId, status: "failed" },
    { id: secondBookingId, status: "paid" },
  ]);
});

test("ride history works before the payment migration and does not query payment attempts", async (t) => {
  const bookingId = "22222222-2222-4222-8222-222222222222";
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{ id: USER_ID, role: "passenger" }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/bookings") {
      return jsonResponse([{ id: bookingId, status: "assigned" }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/booking_contacts") {
      return jsonResponse([]);
    }
    assert.fail(`Payment attempts must not be queried while the feature is disabled: ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/bookings", { headers: { authorization: `Bearer ${USER_TOKEN}` } }),
    makeEnv(),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.bookings[0].id, bookingId);
});

test("accepted ride Checkout uses a restricted test key and saves the server fare session", async (t) => {
  const bookingId = "22222222-2222-4222-8222-222222222222";
  const paymentAttemptId = "77777777-7777-4777-8777-777777777777";
  const checkoutSessionId = "cs_test_steadlanecheckout001";
  const calls = [];
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ url, method, headers, body: init.body });

    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      return jsonResponse([{ id: USER_ID, role: "passenger" }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/prepare_booking_checkout") {
      assert.equal(method, "POST");
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      assert.deepEqual(JSON.parse(init.body), { p_booking_id: bookingId });
      return jsonResponse({
        payment_attempt_id: paymentAttemptId,
        payment_status: "pending",
        amount_cents: 2_800,
        currency: "usd",
        pickup_at: "2027-01-15T16:30:00.000Z",
        checkout_session_id: null,
        checkout_url: null,
        checkout_expires_at: null,
      });
    }
    if (url.origin === "https://api.stripe.com" && url.pathname === "/v1/checkout/sessions") {
      assert.equal(method, "POST");
      assert.equal(headers.get("authorization"), `Bearer ${STRIPE_RESTRICTED_KEY}`);
      const fields = new URLSearchParams(init.body);
      assert.equal(fields.get("line_items[0][price_data][unit_amount]"), "2800");
      assert.equal(fields.get("metadata[steadlane_booking_id]"), bookingId);
      assert.equal(fields.get("metadata[steadlane_payment_attempt_id]"), paymentAttemptId);
      assert.match(fields.get("success_url"), /\?checkout=return&booking_id=/);
      assert.equal(fields.get("cancel_url"), fields.get("success_url"));
      return jsonResponse({
        id: checkoutSessionId,
        url: `https://checkout.stripe.com/c/pay/${checkoutSessionId}`,
        status: "open",
        payment_status: "unpaid",
        livemode: false,
        expires_at: Math.floor(Date.now() / 1000) + 1_800,
      });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/record_booking_checkout_session") {
      assert.equal(method, "POST");
      assert.equal(headers.get("apikey"), SUPABASE_SECRET_KEY);
      assert.equal(headers.has("authorization"), false);
      const body = JSON.parse(init.body);
      assert.equal(body.p_payment_attempt_id, paymentAttemptId);
      assert.equal(body.p_checkout_session_id, checkoutSessionId);
      assert.equal(body.p_checkout_url, `https://checkout.stripe.com/c/pay/${checkoutSessionId}`);
      assert.ok(Number.isFinite(Date.parse(body.p_checkout_expires_at)));
      return jsonResponse({ recorded: true, payment_status: "pending" });
    }
    assert.fail(`Unexpected mocked request: ${method} ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest(`/api/bookings/${bookingId}/checkout-session`, {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: {},
    }),
    makeEnv({ STRIPE_PAYMENTS_ENABLED: "true", STRIPE_SECRET_KEY: STRIPE_RESTRICTED_KEY, STRIPE_WEBHOOK_SECRET }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    url: `https://checkout.stripe.com/c/pay/${checkoutSessionId}`,
    paymentStatus: "pending",
  });
  assert.equal(calls.filter((call) => call.url.origin === "https://api.stripe.com").length, 1);
  assert.equal(calls.filter((call) => call.url.pathname === "/rest/v1/rpc/record_booking_checkout_session").length, 1);
});

test("Checkout retry replaces an expired unlinked session after its first database write failed", async (t) => {
  const bookingId = "22222222-2222-4222-8222-222222222222";
  const firstAttemptId = "77777777-7777-4777-8777-777777777777";
  const retryAttemptId = "88888888-8888-4888-8888-888888888888";
  const expiredSessionId = "cs_test_steadlaneexpired001";
  const replacementSessionId = "cs_test_steadlanereplacement001";
  const expiredUrl = `https://checkout.stripe.com/c/pay/${expiredSessionId}`;
  const replacementUrl = `https://checkout.stripe.com/c/pay/${replacementSessionId}`;
  const calls = [];
  let prepareCalls = 0;
  let stripeSessionCalls = 0;
  let stripeExpireCalls = 0;
  let recordCalls = 0;
  let unlinkedExpiryCalls = 0;

  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ url, method, headers, body: init.body });

    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{ id: USER_ID, role: "passenger" }]);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/prepare_booking_checkout") {
      prepareCalls += 1;
      assert.equal(headers.get("authorization"), `Bearer ${USER_TOKEN}`);
      assert.deepEqual(JSON.parse(init.body), { p_booking_id: bookingId });
      const paymentAttemptId = prepareCalls < 3 ? firstAttemptId : retryAttemptId;
      assert.ok(prepareCalls <= 3, "Checkout must not retry indefinitely");
      return jsonResponse({
        payment_attempt_id: paymentAttemptId,
        payment_status: "pending",
        amount_cents: 2_800,
        currency: "usd",
        pickup_at: "2027-01-15T16:30:00.000Z",
        checkout_session_id: null,
        checkout_url: null,
        checkout_expires_at: null,
      });
    }
    if (url.origin === "https://api.stripe.com" && url.pathname === "/v1/checkout/sessions") {
      stripeSessionCalls += 1;
      const idempotencyKey = headers.get("idempotency-key");
      if (stripeSessionCalls < 3) assert.equal(idempotencyKey, `steadlane-${firstAttemptId}`);
      else assert.equal(idempotencyKey, `steadlane-${retryAttemptId}`);
      if (stripeSessionCalls === 1) {
        return jsonResponse({
          id: expiredSessionId,
          url: expiredUrl,
          status: "open",
          payment_status: "unpaid",
          livemode: false,
          expires_at: Math.floor(Date.now() / 1000) + 1_800,
        });
      }
      if (stripeSessionCalls === 2) {
        return jsonResponse({
          id: expiredSessionId,
          url: expiredUrl,
          status: "expired",
          payment_status: "unpaid",
          livemode: false,
          expires_at: Math.floor(Date.now() / 1000) - 60,
        });
      }
      return jsonResponse({
        id: replacementSessionId,
        url: replacementUrl,
        status: "open",
        payment_status: "unpaid",
        livemode: false,
        expires_at: Math.floor(Date.now() / 1000) + 1_800,
      });
    }
    if (
      url.origin === "https://api.stripe.com" &&
      url.pathname === `/v1/checkout/sessions/${expiredSessionId}/expire`
    ) {
      stripeExpireCalls += 1;
      return jsonResponse({
        id: expiredSessionId,
        url: expiredUrl,
        status: "expired",
        payment_status: "unpaid",
        livemode: false,
        expires_at: Math.floor(Date.now() / 1000) - 60,
      });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/record_booking_checkout_session") {
      recordCalls += 1;
      assert.equal(headers.get("apikey"), SUPABASE_SECRET_KEY);
      assert.equal(headers.has("authorization"), false);
      const body = JSON.parse(init.body);
      assert.equal(body.p_payment_attempt_id, recordCalls === 1 ? firstAttemptId : retryAttemptId);
      if (recordCalls === 1) {
        assert.equal(body.p_checkout_session_id, expiredSessionId);
        assert.equal(body.p_checkout_url, expiredUrl);
        return jsonResponse({ message: "Temporary payment record write failure." }, 503);
      }
      assert.equal(body.p_checkout_session_id, replacementSessionId);
      assert.equal(body.p_checkout_url, replacementUrl);
      return jsonResponse({ recorded: true });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/rpc/expire_unlinked_booking_checkout_attempt") {
      unlinkedExpiryCalls += 1;
      assert.equal(headers.get("apikey"), SUPABASE_SECRET_KEY);
      assert.equal(headers.has("authorization"), false);
      assert.deepEqual(JSON.parse(init.body), { p_payment_attempt_id: firstAttemptId });
      return jsonResponse({ expired: true, payment_status: "expired" });
    }
    assert.fail(`Unexpected mocked request: ${method} ${url.href}`);
  });

  const env = makeEnv({ STRIPE_PAYMENTS_ENABLED: "true", STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET });
  const firstResponse = await worker.fetch(
    apiRequest(`/api/bookings/${bookingId}/checkout-session`, {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: {},
    }),
    env,
  );
  assert.ok(firstResponse.status >= 500, "A failed Checkout record write must not return a payment link");

  const retryResponse = await worker.fetch(
    apiRequest(`/api/bookings/${bookingId}/checkout-session`, {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: {},
    }),
    env,
  );
  const retryPayload = await retryResponse.json();

  assert.equal(retryResponse.status, 200);
  assert.deepEqual(retryPayload, { url: replacementUrl, paymentStatus: "pending" });
  assert.notEqual(retryPayload.url, expiredUrl);
  assert.equal(prepareCalls, 3);
  assert.equal(stripeSessionCalls, 3);
  assert.equal(recordCalls, 2);
  assert.equal(unlinkedExpiryCalls, 1);
  assert.equal(stripeExpireCalls, 0);
});

test("Checkout rejects client-supplied amounts and does not call Stripe", async (t) => {
  const bookingId = "22222222-2222-4222-8222-222222222222";
  let stripeCalls = 0;
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{ id: USER_ID, role: "passenger" }]);
    }
    if (url.origin === "https://api.stripe.com") stripeCalls += 1;
    assert.fail(`Unexpected request: ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest(`/api/bookings/${bookingId}/checkout-session`, {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: { amount: 1, currency: "usd" },
    }),
    makeEnv({ STRIPE_SECRET_KEY }),
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error.code, "invalid_checkout_request");
  assert.equal(stripeCalls, 0);
});

test("Checkout stays unavailable until test payments, storage, and webhook secrets are configured", async (t) => {
  let bookingPreparationCalls = 0;
  installFetchMock(t, async (input) => {
    const url = new URL(input);
    if (url.href === `${SUPABASE_URL}/auth/v1/user`) {
      return jsonResponse({ id: USER_ID, email: "passenger@example.test" });
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/profiles") {
      return jsonResponse([{ id: USER_ID, role: "passenger" }]);
    }
    if (url.pathname === "/rest/v1/rpc/prepare_booking_checkout") bookingPreparationCalls += 1;
    assert.fail(`Unexpected request: ${url.href}`);
  });

  const response = await worker.fetch(
    apiRequest("/api/bookings/22222222-2222-4222-8222-222222222222/checkout-session", {
      method: "POST",
      headers: { authorization: `Bearer ${USER_TOKEN}` },
      body: {},
    }),
    makeEnv({ STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET }),
  );
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.error.code, "stripe_not_configured");
  assert.equal(bookingPreparationCalls, 0);
});

test("Stripe webhook verifies the signature and records a paid session through the server RPC", async (t) => {
  const paymentAttemptId = "77777777-7777-4777-8777-777777777777";
  const checkoutSessionId = "cs_test_steadlanecheckout001";
  const calls = [];
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({ url, method, headers, body: init.body });
    assert.equal(url.origin, SUPABASE_URL);
    assert.equal(url.pathname, "/rest/v1/rpc/process_stripe_webhook_event");
    assert.equal(method, "POST");
    assert.equal(headers.get("apikey"), SUPABASE_SECRET_KEY);
    assert.equal(headers.has("authorization"), false);
    assert.deepEqual(JSON.parse(init.body), {
      p_event_id: "evt_steadlanepaid001",
      p_event_type: "checkout.session.completed",
      p_livemode: false,
      p_payment_attempt_id: paymentAttemptId,
      p_checkout_session_id: checkoutSessionId,
      p_payment_intent_id: "pi_steadlane001",
      p_amount_total: 2_800,
      p_amount_refunded_cents: null,
      p_currency: "usd",
      p_payment_status: "paid",
    });
    return jsonResponse({ duplicate: false, applied: true, payment_status: "paid" });
  });

  const event = {
    id: "evt_steadlanepaid001",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: checkoutSessionId,
        metadata: {
          steadlane_booking_id: "22222222-2222-4222-8222-222222222222",
          steadlane_payment_attempt_id: paymentAttemptId,
        },
        payment_intent: "pi_steadlane001",
        amount_total: 2_800,
        currency: "usd",
        payment_status: "paid",
      },
    },
  };
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const request = new Request(`${APP_ORIGIN}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: rawBody,
  });

  const response = await worker.fetch(request, makeEnv({
    STRIPE_WEBHOOK_SECRET,
    SUPABASE_SECRET_KEY,
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { received: true, duplicate: false });
  assert.equal(calls.length, 1);
});

test("Stripe async payment success webhook records the saved attempt as paid", async (t) => {
  const event = checkoutSessionWebhookEvent({
    eventId: "evt_steadlaneasyncpaid001",
    eventType: "checkout.session.async_payment_succeeded",
    sessionId: "cs_test_steadlaneasyncpaid001",
    paymentIntentId: "pi_steadlaneasyncpaid001",
    paymentStatus: "paid",
  });

  await assertStripeWebhookForwarded(t, event, {
    p_event_id: event.id,
    p_event_type: event.type,
    p_livemode: false,
    p_payment_attempt_id: "77777777-7777-4777-8777-777777777777",
    p_checkout_session_id: "cs_test_steadlaneasyncpaid001",
    p_payment_intent_id: "pi_steadlaneasyncpaid001",
    p_amount_total: 2_800,
    p_amount_refunded_cents: null,
    p_currency: "usd",
    p_payment_status: "paid",
  }, "paid");
});

test("Stripe async payment failure webhook records the saved attempt as failed", async (t) => {
  const event = checkoutSessionWebhookEvent({
    eventId: "evt_steadlaneasyncfailed001",
    eventType: "checkout.session.async_payment_failed",
    sessionId: "cs_test_steadlaneasyncfailed001",
    paymentIntentId: "pi_steadlaneasyncfailed001",
    paymentStatus: "unpaid",
  });

  await assertStripeWebhookForwarded(t, event, {
    p_event_id: event.id,
    p_event_type: event.type,
    p_livemode: false,
    p_payment_attempt_id: "77777777-7777-4777-8777-777777777777",
    p_checkout_session_id: "cs_test_steadlaneasyncfailed001",
    p_payment_intent_id: "pi_steadlaneasyncfailed001",
    p_amount_total: 2_800,
    p_amount_refunded_cents: null,
    p_currency: "usd",
    p_payment_status: "unpaid",
  }, "failed");
});

test("Checkout expiry webhook records the saved attempt as expired", async (t) => {
  const event = checkoutSessionWebhookEvent({
    eventId: "evt_steadlaneexpiredwebhook001",
    eventType: "checkout.session.expired",
    sessionId: "cs_test_steadlaneexpiredwebhook001",
    paymentIntentId: null,
    paymentStatus: "unpaid",
  });

  await assertStripeWebhookForwarded(t, event, {
    p_event_id: event.id,
    p_event_type: event.type,
    p_livemode: false,
    p_payment_attempt_id: "77777777-7777-4777-8777-777777777777",
    p_checkout_session_id: "cs_test_steadlaneexpiredwebhook001",
    p_payment_intent_id: null,
    p_amount_total: 2_800,
    p_amount_refunded_cents: null,
    p_currency: "usd",
    p_payment_status: "unpaid",
  }, "expired");
});

test("Stripe refund webhooks send the cumulative refund amount to the server RPC", async (t) => {
  const paymentIntentId = "pi_steadlane001";
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    assert.equal(url.origin, SUPABASE_URL);
    assert.equal(url.pathname, "/rest/v1/rpc/process_stripe_webhook_event");
    assert.equal(headers.get("apikey"), SUPABASE_SECRET_KEY);
    assert.deepEqual(JSON.parse(init.body), {
      p_event_id: "evt_steadlanerefund001",
      p_event_type: "charge.refunded",
      p_livemode: false,
      p_payment_attempt_id: null,
      p_checkout_session_id: null,
      p_payment_intent_id: paymentIntentId,
      p_amount_total: null,
      p_amount_refunded_cents: 1_400,
      p_currency: "usd",
      p_payment_status: null,
    });
    return jsonResponse({ duplicate: false, applied: true, payment_status: "partially_refunded" });
  });

  const event = {
    id: "evt_steadlanerefund001",
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: "ch_steadlane001",
        payment_intent: paymentIntentId,
        amount_refunded: 1_400,
        currency: "usd",
      },
    },
  };
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const response = await worker.fetch(new Request(`${APP_ORIGIN}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: rawBody,
  }), makeEnv({ STRIPE_WEBHOOK_SECRET, SUPABASE_SECRET_KEY }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { received: true, duplicate: false });
});

test("a valid unmatched refund remains retryable by Stripe", async (t) => {
  const paymentIntentId = "pi_steadlaneunmatched001";
  let rpcCalls = 0;
  installFetchMock(t, async (input, init = {}) => {
    rpcCalls += 1;
    const url = new URL(input);
    const headers = new Headers(init.headers);
    assert.equal(url.origin, SUPABASE_URL);
    assert.equal(url.pathname, "/rest/v1/rpc/process_stripe_webhook_event");
    assert.equal(headers.get("apikey"), SUPABASE_SECRET_KEY);
    assert.equal(headers.has("authorization"), false);
    const body = JSON.parse(init.body);
    assert.equal(body.p_event_type, "charge.refunded");
    assert.equal(body.p_payment_intent_id, paymentIntentId);
    assert.equal(body.p_amount_refunded_cents, 1_400);
    return jsonResponse({ duplicate: false, applied: false });
  });

  const event = {
    id: "evt_steadlaneunmatched001",
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: "ch_steadlaneunmatched001",
        payment_intent: paymentIntentId,
        amount_refunded: 1_400,
        currency: "usd",
      },
    },
  };
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const response = await worker.fetch(new Request(`${APP_ORIGIN}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: rawBody,
  }), makeEnv({ STRIPE_WEBHOOK_SECRET, SUPABASE_SECRET_KEY }));
  const payload = await response.json();

  assert.equal(rpcCalls, 1);
  assert.ok(response.status >= 500 && response.status < 600);
  assert.equal(payload.error.code, "refund_attempt_unavailable");
});

test("Stripe webhook rejects forged signatures before contacting Supabase", async (t) => {
  let upstreamCalls = 0;
  installFetchMock(t, async () => {
    upstreamCalls += 1;
    throw new Error("Forged payment notifications must not reach the database.");
  });
  const request = new Request(`${APP_ORIGIN}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`,
    },
    body: JSON.stringify({ id: "evt_forged001", type: "checkout.session.completed", livemode: false, data: { object: {} } }),
  });

  const response = await worker.fetch(request, makeEnv({ STRIPE_WEBHOOK_SECRET }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error.code, "invalid_stripe_signature");
  assert.equal(upstreamCalls, 0);
});
