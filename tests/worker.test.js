import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const SUPABASE_URL = "https://steadlane-test.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test_public_key";
const SUPABASE_SECRET_KEY = "sb_secret_test_server_key";
const GEOAPIFY_API_KEY = "geoapify_test_server_key";
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

test("GET /api/config exposes only the public Supabase URL and publishable key", async () => {
  const response = await worker.fetch(apiRequest("/api/config"), makeEnv());
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    supabaseUrl: SUPABASE_URL,
    supabasePublishableKey: PUBLISHABLE_KEY,
  });
  assert.equal(JSON.stringify(payload).includes(SUPABASE_SECRET_KEY), false);
  assert.equal(JSON.stringify(payload).includes(GEOAPIFY_API_KEY), false);
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
        features: [{
          properties: pickup
            ? { place_id: "pickup-place-001", formatted: "Canonical Pickup, Cincinnati", lat: 39.1, lon: -84.5 }
            : { place_id: "destination-place-002", formatted: "Canonical Destination, Cincinnati", lat: 39.2, lon: -84.4 },
        }],
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
            ? { place_id: "guest-pickup-001", formatted: "Guest pickup, Cincinnati", lat: 39.1, lon: -84.5 }
            : { place_id: "guest-destination-002", formatted: "Guest destination, Cincinnati", lat: 39.2, lon: -84.4 },
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
        "guest-pickup-001": { formatted: "Pickup, Cincinnati", lat: 39.1, lon: -84.5 },
        "middle-stop-002": { formatted: "Stop, Cincinnati", lat: 39.15, lon: -84.45 },
        "guest-destination-003": { formatted: "Destination, Cincinnati", lat: 39.2, lon: -84.4 },
      };
      return jsonResponse({ features: [{ properties: { place_id: placeId, ...places[placeId] } }] });
    }
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v1/routing") {
      assert.equal(url.searchParams.get("waypoints"), "39.1,-84.5|39.15,-84.45|39.2,-84.4");
      assert.equal(url.searchParams.get("intermediate_waypoint_mode"), "stopover");
      return jsonResponse({
        features: [{
          properties: { distance: 16_093.44, time: 1_200 },
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [[-84.5, 39.1], [-84.45, 39.15]],
              [[-84.45, 39.15], [-84.4, 39.2]],
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
  assert.equal(payload.quote.stops[0].placeId, "middle-stop-002");
  assert.equal(payload.quote.route.geometry.type, "LineString");
  assert.deepEqual(payload.quote.route.geometry.coordinates, [
    [-84.5, 39.1],
    [-84.45, 39.15],
    [-84.4, 39.2],
  ]);
  assert.equal(payload.quote.fare.stopCount, 1);
  assert.equal(payload.quote.fare.stopCharge, null);
  assert.equal(payload.quote.fare.knownSubtotal, 28);
  assert.equal(payload.quote.fare.bookable, false);
  assert.equal(payload.quote.fare.total, null);
  assert.equal(payload.quote.bookingEligible, false);
  assert.equal(calls.length, 4);
});

test("public address autocomplete filters suggestions and works without Supabase config", async (t) => {
  installFetchMock(t, async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (url.origin === "https://api.geoapify.com" && url.pathname === "/v1/geocode/autocomplete") {
      assert.equal(url.searchParams.get("filter"), "rect:-84.92,38.82,-84.2,39.6");
      assert.equal(url.searchParams.get("apiKey"), GEOAPIFY_API_KEY);
      assert.equal(headers.has("authorization"), false);
      return jsonResponse({
        features: [
          { properties: { place_id: "boundary-southwest-001", formatted: "Southwest edge", lat: 38.82, lon: -84.92 } },
          { properties: { place_id: "boundary-northeast-002", formatted: "Northeast edge", lat: 39.6, lon: -84.2 } },
          { properties: { place_id: "outside-east-003", formatted: "Outside east edge", lat: 39.2, lon: -84.19 } },
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
    "boundary-southwest-001",
    "boundary-northeast-002",
  ]);
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

test("route quotes reject canonical addresses outside the beta rectangle", async (t) => {
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
            ? { place_id: "outside-place-001", formatted: "Outside service area", lat: 39.1, lon: -85 }
            : { place_id: "inside-place-002", formatted: "Inside Cincinnati area", lat: 39.2, lon: -84.4 },
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
