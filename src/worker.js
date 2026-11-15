import { calculateFareBreakdown, DEFAULT_RATES } from "./pricing.js";
import { validateWeeklySchedule } from "./scheduling.js";

const MAX_API_BODY_BYTES = 20_000;
const MAX_LABEL_LENGTH = 240;
const MAX_ROUTE_POINTS = 10_000;
const MAX_DISTANCE_MILES = 2_500;
const MAX_DURATION_MINUTES = 1_440;
const QUOTE_LIFETIME_MS = 10 * 60 * 1000;
const PRICING_VERSION = "sample-v1";
const WEEKLY_SCHEDULE_TIME_ZONE = "America/New_York";
const BETA_SERVICE_AREA = Object.freeze({
  westLongitude: -84.92,
  eastLongitude: -84.20,
  southLatitude: 38.82,
  northLatitude: 39.60,
});
const BOOKING_COLUMNS = [
  "id",
  "pickup_label",
  "destination_label",
  "pickup_at",
  "passenger_count",
  "distance_miles",
  "duration_minutes",
  "fare_total_cents",
  "fare_stop_cents",
  "fare_known_subtotal_cents",
  "stop_count",
  "currency",
  "status",
  "assigned_driver_id",
  "recurring_series_id",
  "created_at",
  "route_geometry",
  "stops",
].join(",");

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function fail(status, code, message) {
  throw new HttpError(status, code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function currentConfig(env) {
  const supabaseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  const supabasePublishableKey = typeof env.SUPABASE_PUBLISHABLE_KEY === "string"
    ? env.SUPABASE_PUBLISHABLE_KEY.trim()
    : "";

  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    return null;
  }

  const localHost = ["localhost", "127.0.0.1"].includes(parsedUrl.hostname);
  const validSupabaseHost = parsedUrl.hostname.endsWith(".supabase.co");
  const validScheme = parsedUrl.protocol === "https:" || (localHost && parsedUrl.protocol === "http:");
  const validKey = supabasePublishableKey.startsWith("sb_publishable_");
  const placeholder = /YOUR_PROJECT|REPLACE_ME|REPLACE_WITH/i.test(supabaseUrl + supabasePublishableKey);
  if (
    !validScheme ||
    (!validSupabaseHost && !localHost) ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash ||
    !validKey ||
    placeholder ||
    parsedUrl.username ||
    parsedUrl.password
  ) return null;

  return {
    supabaseUrl: parsedUrl.href.replace(/\/+$/, ""),
    supabasePublishableKey,
  };
}

function stopFeeCents(env) {
  const configured = env.STOP_FEE_CENTS;
  if (configured === undefined || configured === null || configured === "") return null;
  const normalized = typeof configured === "number" ? String(configured) : configured;
  if (typeof normalized !== "string" || !/^[1-9]\d{0,5}$/.test(normalized)) {
    fail(503, "invalid_stop_fee", "The configured stop fee is invalid.");
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value > 500_000) {
    fail(503, "invalid_stop_fee", "The configured stop fee is invalid.");
  }
  return value;
}

function fareRates(env) {
  const configuredStopFee = stopFeeCents(env);
  return {
    ...DEFAULT_RATES,
    stopFeePerStop: configuredStopFee === null ? null : configuredStopFee / 100,
  };
}

function ratePayload(env) {
  const rates = fareRates(env);
  return {
    currency: "USD",
    provisional: true,
    rates: {
      baseFare: rates.baseFare,
      perMile: rates.perMile,
      perMinute: rates.perMinute,
      minimumFare: rates.minimumFare,
      bookingFee: rates.bookingFee,
      stopFeePerStop: rates.stopFeePerStop,
    },
  };
}

async function enforceRateLimit(request, env, bindingName) {
  const limiter = env[bindingName];
  if (!limiter || typeof limiter.limit !== "function") {
    fail(503, "rate_limit_unavailable", "The public estimate service is not available yet.");
  }
  const ipAddress = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  let result;
  try {
    result = await limiter.limit({ key: `ip:${ipAddress}` });
  } catch {
    fail(503, "rate_limit_unavailable", "The public estimate service is not available yet.");
  }
  if (result?.success !== true) {
    fail(429, "rate_limit_exceeded", "Too many requests. Wait a minute and try again.");
  }
}

function ensureSameOrigin(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== requestUrl.origin) {
    fail(403, "origin_not_allowed", "This request must come from Steadlane.");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    fail(403, "origin_not_allowed", "This request must come from Steadlane.");
  }

  const isMutation = !["GET", "HEAD"].includes(request.method.toUpperCase());
  if (isMutation && origin === null) {
    fail(403, "origin_required", "This request must come from Steadlane.");
  }
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    fail(415, "json_required", "Send this request as JSON.");
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_BODY_BYTES) {
    fail(413, "body_too_large", "The request is too large.");
  }
  if (!request.body) fail(400, "invalid_json", "Send a JSON request body.");

  const reader = request.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_API_BODY_BYTES) {
        await reader.cancel();
        fail(413, "body_too_large", "The request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(400, "invalid_json", "Send a valid JSON request body.");
  }
  if (!isPlainObject(value)) fail(400, "invalid_json", "The JSON body must be an object.");
  return value;
}

async function readUpstreamJson(response, serviceName) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The upstream may return a non-JSON failure page. It is never relayed.
  }
  if (!response.ok) {
    if (serviceName === "auth" && response.status === 401) {
      fail(401, "sign_in_required", "Sign in again to continue.");
    }
    if (serviceName === "database" && response.status === 401) {
      fail(401, "sign_in_required", "Sign in again to continue.");
    }
    if (serviceName === "database" && response.status === 403) {
      fail(403, "not_allowed", "You do not have permission to do that.");
    }
    if (serviceName === "database" && payload?.code === "23505") {
      fail(409, "already_processed", "This request was already used or processed.");
    }
    if (serviceName === "database" && payload?.code === "42501") {
      fail(404, "not_found", "The requested record was not found.");
    }
    if (serviceName === "database" && payload?.code === "22023") {
      fail(400, "invalid_request", "Check the request details and try again.");
    }
    if (serviceName === "database" && payload?.code === "P0001") {
      const message = String(payload.message || "").toLowerCase();
      if (message.includes("expired")) fail(409, "quote_expired", "This fare quote has expired. Request a new one.");
      if (message.includes("already used")) fail(409, "quote_used", "This fare quote has already been used.");
      if (message.includes("no longer pending")) fail(409, "not_pending", "This ride request is no longer pending.");
      if (message.includes("contact details")) fail(409, "contact_required", "Add your name and phone number before requesting a ride.");
      if (message.includes("stop pricing")) fail(409, "stop_pricing_required", "A stop fee must be configured before this route can be booked.");
      if (message.includes("decision already recorded")) fail(409, "decision_recorded", "You already responded to this ride request.");
      if (message.includes("driver is not available")) fail(409, "driver_unavailable", "This pickup is outside your saved availability.");
      if (message.includes("role")) fail(403, "role_required", "This account is not authorized for that action.");
    }
    fail(502, `${serviceName}_unavailable`, "A connected service could not complete the request.");
  }
  return payload;
}

function requireGeoapifyKey(env) {
  if (typeof env.GEOAPIFY_API_KEY !== "string" || env.GEOAPIFY_API_KEY.length < 8) {
    fail(503, "maps_not_configured", "Address and map services are not configured yet.");
  }
  return env.GEOAPIFY_API_KEY;
}

async function fetchGeoapifyJson(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
  } catch {
    fail(502, "maps_unavailable", "The address or route service could not be reached.");
  }
  if (!response.ok) {
    if (response.status === 429) fail(503, "maps_busy", "The address or route service is busy. Try again shortly.");
    fail(502, "maps_unavailable", "The address or route service could not complete the request.");
  }
  try {
    return await response.json();
  } catch {
    fail(502, "maps_invalid_response", "The address or route service returned an invalid response.");
  }
}

async function supabaseRequest(env, path, { method = "GET", accessToken, secretKey, body, prefer } = {}) {
  const config = currentConfig(env);
  if (!config) fail(503, "supabase_not_configured", "The booking service is not configured yet.");
  if (secretKey && (path !== "/rest/v1/ride_quotes" || method !== "POST" || accessToken)) {
    fail(500, "invalid_server_database_operation", "The server database operation is not allowed.");
  }
  const url = new URL(path, `${config.supabaseUrl}/`);
  const headers = new Headers({
    apikey: secretKey || config.supabasePublishableKey,
    accept: "application/json",
  });
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  if (prefer) headers.set("prefer", prefer);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
  } catch {
    fail(502, "supabase_unavailable", "The booking service could not be reached.");
  }

  if (response.status === 204) return null;
  let payload = null;
  try {
    const text = await response.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    if (response.ok) fail(502, "supabase_invalid_response", "The booking service returned an invalid response.");
  }
  if (!response.ok) {
    return readUpstreamJson(new Response(JSON.stringify(payload), { status: response.status }), "database");
  }
  return payload;
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~-]{20,8192})$/i.exec(authorization);
  if (!match || match[1].split(".").length !== 3) {
    fail(401, "sign_in_required", "Sign in to continue.");
  }
  return match[1];
}

async function requireUser(request, env) {
  const token = bearerToken(request);
  const config = currentConfig(env);
  if (!config) fail(503, "supabase_not_configured", "The booking service is not configured yet.");
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: config.supabasePublishableKey,
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    fail(502, "supabase_unavailable", "The sign-in service could not be reached.");
  }

  const user = await readUpstreamJson(response, "auth");
  if (!user || !validUuid(user.id)) fail(401, "sign_in_required", "Sign in again to continue.");
  return { id: user.id, email: typeof user.email === "string" ? user.email : null, token };
}

async function optionalUser(request, env) {
  return request.headers.has("authorization") ? requireUser(request, env) : null;
}

async function getProfile(user, env) {
  const query = new URLSearchParams({
    select: "id,role,full_name,phone,created_at",
    id: `eq.${user.id}`,
    limit: "1",
  });
  const rows = await supabaseRequest(env, `/rest/v1/profiles?${query}`, { accessToken: user.token });
  if (!Array.isArray(rows) || !rows[0]) fail(403, "profile_missing", "This account is not ready for booking yet.");
  return rows[0];
}

async function requirePassenger(user, env) {
  const profile = await getProfile(user, env);
  if (profile.role !== "passenger") fail(403, "passenger_required", "Passenger access is required for this action.");
  return profile;
}

function formatProfile(user, profile) {
  return {
    id: profile.id,
    email: user.email,
    role: profile.role,
    full_name: profile.full_name,
    phone: profile.phone,
    created_at: profile.created_at,
  };
}

function validateNameAndPhone(body) {
  if (Object.keys(body).some((key) => !["fullName", "phone"].includes(key))) {
    fail(400, "invalid_profile", "Only name and phone number can be changed here.");
  }
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (fullName.length < 2 || fullName.length > 120) {
    fail(400, "invalid_name", "Enter a name between 2 and 120 characters.");
  }
  if (phone.length < 7 || phone.length > 25 || !/^[+0-9() .-]+$/.test(phone) || !/\d/.test(phone)) {
    fail(400, "invalid_phone", "Enter a phone number with 7 to 25 characters and at least one digit.");
  }
  return { full_name: fullName, phone };
}

async function patchProfile(request, env, user) {
  const body = validateNameAndPhone(await readJson(request));
  const query = new URLSearchParams({ id: `eq.${user.id}`, select: "id,role,full_name,phone,created_at" });
  const rows = await supabaseRequest(env, `/rest/v1/profiles?${query}`, {
    method: "PATCH",
    accessToken: user.token,
    body,
    prefer: "return=representation",
  });
  if (!Array.isArray(rows) || !rows[0]) fail(403, "profile_missing", "This account is not ready for booking yet.");
  return formatProfile(user, rows[0]);
}

function validatePlaceId(value, name) {
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || /[\s\u0000-\u001f]/.test(value)) {
    fail(400, "invalid_place", `Choose a valid ${name} from the address suggestions.`);
  }
  return value;
}

function validatePickupAt(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    fail(400, "invalid_pickup_time", "Choose a pickup date and time with a timezone.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    fail(400, "invalid_pickup_time", "Choose a pickup time in the future.");
  }
  if (timestamp > Date.now() + 365 * 24 * 60 * 60 * 1000) {
    fail(400, "invalid_pickup_time", "Choose a pickup time within the next year.");
  }
  return new Date(timestamp).toISOString();
}

function validCoordinate(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

function isInsideBetaServiceArea(latitude, longitude) {
  return (
    validCoordinate(latitude, longitude) &&
    longitude >= BETA_SERVICE_AREA.westLongitude &&
    longitude <= BETA_SERVICE_AREA.eastLongitude &&
    latitude >= BETA_SERVICE_AREA.southLatitude &&
    latitude <= BETA_SERVICE_AREA.northLatitude
  );
}

async function getPlaceDetails(placeId, apiKey) {
  const url = new URL("https://api.geoapify.com/v2/place-details");
  url.searchParams.set("id", placeId);
  url.searchParams.set("apiKey", apiKey);
  const result = await fetchGeoapifyJson(url);
  const detailsFeature = Array.isArray(result?.features)
    ? result.features.find((feature) => feature?.properties?.feature_type === "details")
    : null;
  const properties = detailsFeature?.properties;
  const latitude = Number(properties?.lat);
  const longitude = Number(properties?.lon);
  const label = typeof properties?.formatted === "string" ? properties.formatted.trim() : "";
  const returnedPlaceId = properties?.place_id;
  if (
    !validCoordinate(latitude, longitude) ||
    !label ||
    typeof returnedPlaceId !== "string" ||
    returnedPlaceId.length < 8 ||
    returnedPlaceId.length > 512 ||
    /[\s\u0000-\u001f]/.test(returnedPlaceId) ||
    label.length > MAX_LABEL_LENGTH
  ) {
    fail(400, "invalid_place", "Choose an address returned by the address suggestions.");
  }
  return { label, latitude, longitude, placeId: returnedPlaceId };
}

function normalizeRouteGeometry(geometry) {
  let coordinates;
  if (geometry?.type === "LineString" && Array.isArray(geometry.coordinates)) {
    coordinates = geometry.coordinates;
  } else if (
    geometry?.type === "MultiLineString" &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length >= 1 &&
    geometry.coordinates.length <= 4
  ) {
    coordinates = [];
    for (const line of geometry.coordinates) {
      if (!Array.isArray(line) || line.length < 2) return null;
      for (const coordinate of line) {
        const previous = coordinates.at(-1);
        if (
          previous &&
          Array.isArray(coordinate) &&
          coordinate.length >= 2 &&
          Number(previous[0]) === Number(coordinate[0]) &&
          Number(previous[1]) === Number(coordinate[1])
        ) continue;
        coordinates.push(coordinate);
      }
    }
  } else {
    return null;
  }

  if (coordinates.length < 2 || coordinates.length > MAX_ROUTE_POINTS) return null;
  if (!coordinates.every((coordinate) =>
    Array.isArray(coordinate) && coordinate.length >= 2 && validCoordinate(Number(coordinate[1]), Number(coordinate[0]))
  )) return null;
  return { type: "LineString", coordinates };
}

function cents(amount) {
  const value = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(value) || value < 0) fail(400, "invalid_fare", "The fare is outside the supported range.");
  return value;
}

async function createRouteQuote(request, env) {
  const user = await optionalUser(request, env);
  if (user) await requirePassenger(user, env);
  const body = await readJson(request);
  if (!isPlainObject(body.pickup) || !isPlainObject(body.destination)) {
    fail(400, "invalid_route", "Choose a pickup and destination from the address suggestions.");
  }
  const pickupPlaceId = validatePlaceId(body.pickup.placeId, "pickup");
  const destinationPlaceId = validatePlaceId(body.destination.placeId, "destination");
  const rawStops = body.stops === undefined ? [] : body.stops;
  if (!Array.isArray(rawStops) || rawStops.length > 3) {
    fail(400, "invalid_stops", "Choose up to three intermediate stops from the address suggestions.");
  }
  const stopPlaceIds = rawStops.map((stop, index) => {
    if (!isPlainObject(stop)) fail(400, "invalid_stops", `Choose a valid stop ${index + 1} from the address suggestions.`);
    return validatePlaceId(stop.placeId, `stop ${index + 1}`);
  });
  const selectedPlaceIds = [pickupPlaceId, ...stopPlaceIds, destinationPlaceId];
  if (new Set(selectedPlaceIds).size !== selectedPlaceIds.length) {
    fail(400, "duplicate_address", "Choose a different pickup, stop, and destination for each route point.");
  }
  const pickupAt = validatePickupAt(body.pickupAt);
  const passengerCount = Number(body.passengerCount);
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 6) {
    fail(400, "invalid_passenger_count", "Choose between one and six passengers.");
  }

  let rates;
  try {
    rates = fareRates(env);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(503, "invalid_stop_fee", "The configured stop fee is invalid.");
  }
  const apiKey = requireGeoapifyKey(env);
  const resolvedPlaces = await Promise.all(
    selectedPlaceIds.map((placeId) => getPlaceDetails(placeId, apiKey)),
  );
  if (new Set(resolvedPlaces.map((place) => place.placeId)).size !== resolvedPlaces.length) {
    fail(400, "duplicate_address", "Choose a different pickup, stop, and destination for each route point.");
  }
  if (resolvedPlaces.some((place) => !isInsideBetaServiceArea(place.latitude, place.longitude))) {
    fail(422, "outside_service_area", "Pickup and destination must both be within the current Cincinnati and Northern Kentucky beta service area.");
  }
  const pickup = resolvedPlaces[0];
  const destination = resolvedPlaces.at(-1);
  const stops = resolvedPlaces.slice(1, -1).map((place) => ({
    place_id: place.placeId,
    label: place.label,
    latitude: place.latitude,
    longitude: place.longitude,
  }));

  const routeUrl = new URL("https://api.geoapify.com/v1/routing");
  routeUrl.searchParams.set(
    "waypoints",
    resolvedPlaces.map((place) => `${place.latitude},${place.longitude}`).join("|"),
  );
  routeUrl.searchParams.set("mode", "drive");
  if (stops.length) routeUrl.searchParams.set("intermediate_waypoint_mode", "stopover");
  routeUrl.searchParams.set("apiKey", apiKey);
  const routePayload = await fetchGeoapifyJson(routeUrl);
  const routeFeature = Array.isArray(routePayload?.features) ? routePayload.features[0] : null;
  const distanceMeters = Number(routeFeature?.properties?.distance);
  const durationSeconds = Math.ceil(Number(routeFeature?.properties?.time));
  const geometry = normalizeRouteGeometry(routeFeature?.geometry);

  if (
    !Number.isFinite(distanceMeters) ||
    !Number.isFinite(durationSeconds) ||
    distanceMeters <= 0 ||
    durationSeconds <= 0 ||
    distanceMeters > MAX_DISTANCE_MILES * 1609.344 ||
    durationSeconds > MAX_DURATION_MINUTES * 60 ||
    !geometry
  ) {
    fail(422, "route_unavailable", "A valid driving route could not be calculated for those addresses.");
  }

  const distanceMiles = distanceMeters / 1609.344;
  const durationMinutes = Math.ceil(durationSeconds / 60);
  let fare;
  try {
    fare = calculateFareBreakdown(
      { distanceMiles, durationMinutes, stopCount: stops.length },
      rates,
    );
  } catch {
    fail(422, "fare_unavailable", "A fare estimate could not be calculated for this route.");
  }

  const fareCents = {
    base: cents(fare.baseFare),
    distance: cents(fare.distanceCharge),
    duration: cents(fare.durationCharge),
    minimumAdjustment: cents(fare.minimumAdjustment),
    bookingFee: cents(fare.bookingFee),
    stopCharge: fare.stopCharge === null ? null : cents(fare.stopCharge),
    knownSubtotal: cents(fare.knownSubtotal),
    total: fare.total === null ? null : cents(fare.total),
  };
  const displayedParts =
    fareCents.base +
    fareCents.distance +
    fareCents.duration +
    fareCents.minimumAdjustment +
    fareCents.bookingFee +
    (fareCents.stopCharge ?? 0);
  const amountToMatch = fareCents.total ?? fareCents.knownSubtotal;
  const roundingDifference = amountToMatch - displayedParts;
  if (roundingDifference !== 0) {
    const adjustmentKey = fareCents.minimumAdjustment > 0 ? "minimumAdjustment" : "distance";
    fareCents[adjustmentKey] += roundingDifference;
    if (fareCents[adjustmentKey] < 0) fail(422, "fare_unavailable", "A fare estimate could not be calculated for this route.");
  }
  if (amountToMatch > 500_000) fail(422, "fare_unavailable", "The fare estimate is outside the supported range.");

  const bookingEligible = Boolean(user && fare.bookable);
  const quoteId = bookingEligible ? crypto.randomUUID() : null;
  const expiresAt = bookingEligible
    ? new Date(Date.now() + QUOTE_LIFETIME_MS).toISOString()
    : null;

  if (bookingEligible) {
    if (typeof env.SUPABASE_SECRET_KEY !== "string" || !env.SUPABASE_SECRET_KEY.startsWith("sb_secret_")) {
      fail(503, "quote_storage_not_configured", "Fare requests are not configured for booking yet.");
    }
    const quoteRow = {
      id: quoteId,
      passenger_id: user.id,
      pickup_label: pickup.label,
      pickup_latitude: pickup.latitude,
      pickup_longitude: pickup.longitude,
      destination_label: destination.label,
      destination_latitude: destination.latitude,
      destination_longitude: destination.longitude,
      stops,
      stop_count: stops.length,
      pickup_at: pickupAt,
      passenger_count: passengerCount,
      distance_meters: distanceMeters,
      duration_seconds: durationSeconds,
      distance_miles: distanceMiles,
      duration_minutes: durationMinutes,
      route_geometry: geometry,
      fare_base_cents: fareCents.base,
      fare_distance_cents: fareCents.distance,
      fare_duration_cents: fareCents.duration,
      fare_minimum_adjustment_cents: fareCents.minimumAdjustment,
      fare_booking_fee_cents: fareCents.bookingFee,
      fare_stop_cents: fareCents.stopCharge,
      fare_known_subtotal_cents: fareCents.knownSubtotal,
      fare_total_cents: fareCents.total,
      bookable: fare.bookable,
      currency: "USD",
      pricing_version: PRICING_VERSION,
      provisional: true,
      expires_at: expiresAt,
    };

    await supabaseRequest(env, "/rest/v1/ride_quotes", {
      method: "POST",
      secretKey: env.SUPABASE_SECRET_KEY,
      body: quoteRow,
      prefer: "return=minimal",
    });
  }

  return {
    quote: {
      id: quoteId,
      expiresAt,
      currency: "USD",
      provisional: true,
      bookingEligible,
      stops: stops.map(({ place_id, label, latitude, longitude }) => ({
        placeId: place_id,
        label,
        latitude,
        longitude,
      })),
      route: {
        distanceMeters,
        durationSeconds,
        distanceMiles,
        durationMinutes,
        geometry,
      },
      fare: {
        baseFare: fareCents.base / 100,
        distanceCharge: fareCents.distance / 100,
        durationCharge: fareCents.duration / 100,
        minimumAdjustment: fareCents.minimumAdjustment / 100,
        bookingFee: fareCents.bookingFee / 100,
        stopCount: fare.stopCount,
        stopCharge: fareCents.stopCharge === null ? null : fareCents.stopCharge / 100,
        knownSubtotal: fareCents.knownSubtotal / 100,
        bookable: fare.bookable,
        total: fareCents.total === null ? null : fareCents.total / 100,
      },
    },
  };
}

async function searchAddresses(request, env) {
  const query = new URL(request.url).searchParams.get("q")?.trim() || "";
  if (query.length < 2 || query.length > 160 || /[\u0000-\u001f]/.test(query)) {
    fail(400, "invalid_query", "Enter an address between 2 and 160 characters.");
  }
  const url = new URL("https://api.geoapify.com/v1/geocode/autocomplete");
  url.searchParams.set("text", query);
  url.searchParams.set("limit", "6");
  url.searchParams.set("lang", "en");
  url.searchParams.set(
    "filter",
    `rect:${BETA_SERVICE_AREA.westLongitude},${BETA_SERVICE_AREA.southLatitude},${BETA_SERVICE_AREA.eastLongitude},${BETA_SERVICE_AREA.northLatitude}`,
  );
  url.searchParams.set("apiKey", requireGeoapifyKey(env));
  const result = await fetchGeoapifyJson(url);
  const features = Array.isArray(result?.features) ? result.features : [];
  const seen = new Set();
  const suggestions = [];
  for (const feature of features) {
    const properties = feature?.properties;
    const placeId = properties?.place_id;
    const label = typeof properties?.formatted === "string" ? properties.formatted.trim() : "";
    const latitude = Number(properties?.lat);
    const longitude = Number(properties?.lon);
    if (
      typeof placeId !== "string" ||
      placeId.length < 8 ||
      placeId.length > 512 ||
      !label ||
      label.length > MAX_LABEL_LENGTH ||
      !validCoordinate(latitude, longitude) ||
      !isInsideBetaServiceArea(latitude, longitude) ||
      seen.has(placeId)
    ) continue;
    seen.add(placeId);
    suggestions.push({ placeId, label, lat: latitude, lon: longitude });
  }
  return { suggestions };
}

function validateAvailability(input) {
  if (!Array.isArray(input) || input.length > 7) {
    fail(400, "invalid_availability", "Availability must contain no more than one window per weekday.");
  }
  const days = new Set();
  const availability = input.map((entry) => {
    if (!isPlainObject(entry)) fail(400, "invalid_availability", "Each availability window must be an object.");
    const { dayOfWeek, startTime, endTime } = entry;
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7 || days.has(dayOfWeek)) {
      fail(400, "invalid_availability", "Choose each ISO weekday once (Monday 1 through Sunday 7).");
    }
    if (
      typeof startTime !== "string" ||
      typeof endTime !== "string" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime) ||
      startTime >= endTime
    ) {
      fail(400, "invalid_availability", "Each window must be a same-day 24-hour time range that does not cross midnight.");
    }
    days.add(dayOfWeek);
    return { dayOfWeek, startTime, endTime };
  });
  return availability.sort((left, right) => left.dayOfWeek - right.dayOfWeek);
}

function normalizeAvailabilityTime(value) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(value)) {
    fail(502, "availability_invalid_response", "The availability service returned an invalid response.");
  }
  return value.slice(0, 5);
}

async function getDriverAvailability(user, env) {
  const profile = await getProfile(user, env);
  if (profile.role !== "driver") fail(403, "driver_required", "Invited driver access is required for this action.");
  const query = new URLSearchParams({
    select: "day_of_week,start_time,end_time",
    driver_id: `eq.${user.id}`,
    order: "day_of_week.asc",
  });
  const rows = await supabaseRequest(env, `/rest/v1/driver_weekly_availability?${query}`, {
    accessToken: user.token,
  });
  if (!Array.isArray(rows)) fail(502, "availability_invalid_response", "The availability service returned an invalid response.");
  return {
    availability: rows.map((row) => ({
      dayOfWeek: Number(row.day_of_week),
      startTime: normalizeAvailabilityTime(row.start_time),
      endTime: normalizeAvailabilityTime(row.end_time),
    })),
  };
}

async function saveDriverAvailability(request, user, env) {
  const profile = await getProfile(user, env);
  if (profile.role !== "driver") fail(403, "driver_required", "Invited driver access is required for this action.");
  const body = await readJson(request);
  if (Object.keys(body).some((key) => key !== "availability")) {
    fail(400, "invalid_availability", "Only the availability schedule can be changed here.");
  }
  const availability = validateAvailability(body.availability);
  const databaseAvailability = availability.map((window) => ({
    day_of_week: window.dayOfWeek,
    start_time: window.startTime,
    end_time: window.endTime,
  }));
  await supabaseRequest(env, "/rest/v1/rpc/set_driver_availability", {
    method: "POST",
    accessToken: user.token,
    body: { p_availability: databaseAvailability },
  });
  return { availability };
}

async function createRecurringBooking(request, user, env) {
  await requirePassenger(user, env);
  const body = await readJson(request);
  if (!validUuid(body.quoteId) || !validUuid(body.idempotencyKey)) {
    fail(400, "invalid_booking", "The quote and request IDs must be valid.");
  }
  let schedule;
  try {
    schedule = validateWeeklySchedule({
      weekdays: body.weekdays,
      startDate: body.startDate,
      endDate: body.endDate,
      pickupTime: body.pickupTime,
      timeZone: WEEKLY_SCHEDULE_TIME_ZONE,
    });
  } catch (error) {
    fail(400, "invalid_recurring_schedule", error instanceof Error ? error.message : "Check the weekly schedule and try again.");
  }

  const result = await supabaseRequest(env, "/rest/v1/rpc/create_recurring_bookings_from_quote", {
    method: "POST",
    accessToken: user.token,
    body: {
      p_quote_id: body.quoteId,
      p_idempotency_key: body.idempotencyKey,
      p_weekdays: schedule.weekdays,
      p_start_date: schedule.startDate,
      p_end_date: schedule.endDate,
      p_pickup_time: schedule.pickupTime,
    },
  });
  if (
    !isPlainObject(result) ||
    !isPlainObject(result.series) ||
    !validUuid(result.series.id) ||
    !Array.isArray(result.bookings)
  ) {
    fail(502, "booking_invalid_response", "The recurring booking service returned an invalid response.");
  }
  return {
    series: result.series,
    bookings: await attachContacts(env, user, result.bookings),
  };
}

async function cancelRecurringBooking(user, env, seriesId) {
  await requirePassenger(user, env);
  if (!validUuid(seriesId)) fail(400, "invalid_series_id", "The recurring series ID is invalid.");
  const result = await supabaseRequest(env, "/rest/v1/rpc/cancel_recurring_booking_series", {
    method: "POST",
    accessToken: user.token,
    body: { p_series_id: seriesId },
  });
  if (!isPlainObject(result) || !validUuid(result.id)) {
    fail(502, "booking_invalid_response", "The recurring booking service returned an invalid response.");
  }
  return { series: result };
}

async function attachContacts(env, user, rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id).filter(validUuid);
  if (ids.length === 0) return rows;
  const filter = `in.(${ids.join(",")})`;
  const query = new URLSearchParams({
    select: "booking_id,passenger_name,passenger_phone",
    booking_id: filter,
  });
  const contacts = await supabaseRequest(env, `/rest/v1/booking_contacts?${query}`, { accessToken: user.token });
  const contactById = new Map(
    (Array.isArray(contacts) ? contacts : []).map((contact) => [contact.booking_id, contact]),
  );
  return rows.map((row) => ({ ...row, ...(contactById.get(row.id) || {}) }));
}

async function createBooking(request, env, user) {
  await requirePassenger(user, env);
  const body = await readJson(request);
  if (!validUuid(body.quoteId) || !validUuid(body.idempotencyKey)) {
    fail(400, "invalid_booking", "The quote and request IDs must be valid.");
  }
  const result = await supabaseRequest(env, "/rest/v1/rpc/create_booking_from_quote", {
    method: "POST",
    accessToken: user.token,
    body: { p_quote_id: body.quoteId, p_idempotency_key: body.idempotencyKey },
  });
  if (!isPlainObject(result) || !validUuid(result.id)) fail(502, "booking_invalid_response", "The booking service returned an invalid response.");
  const [booking] = await attachContacts(env, user, [result]);
  return { booking };
}

async function listBookings(request, env, user) {
  await getProfile(user, env);
  const requestedLimit = Number(new URL(request.url).searchParams.get("limit") || "50");
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 50;
  const query = new URLSearchParams({
    select: BOOKING_COLUMNS,
    order: "created_at.desc",
    limit: String(limit),
  });
  const rows = await supabaseRequest(env, `/rest/v1/bookings?${query}`, { accessToken: user.token });
  if (!Array.isArray(rows)) fail(502, "booking_invalid_response", "The booking service returned an invalid response.");
  return { bookings: await attachContacts(env, user, rows) };
}

async function respondToBooking(request, env, user) {
  const profile = await getProfile(user, env);
  if (profile.role !== "driver") fail(403, "driver_required", "Invited driver access is required for this action.");
  const body = await readJson(request);
  if (!validUuid(body.bookingId) || !["accept", "decline"].includes(body.decision)) {
    fail(400, "invalid_driver_response", "Choose a ride request and accept or decline it.");
  }
  const result = await supabaseRequest(env, "/rest/v1/rpc/respond_to_booking", {
    method: "POST",
    accessToken: user.token,
    body: { p_booking_id: body.bookingId, p_decision: body.decision },
  });
  if (!isPlainObject(result) || !validUuid(result.id)) fail(502, "booking_invalid_response", "The booking service returned an invalid response.");
  const [booking] = await attachContacts(env, user, [result]);
  return { booking };
}

async function cancelBooking(request, env, user, bookingId) {
  await requirePassenger(user, env);
  if (!validUuid(bookingId)) fail(400, "invalid_booking_id", "The ride request ID is invalid.");
  await readJson(request);
  const result = await supabaseRequest(env, "/rest/v1/rpc/cancel_booking", {
    method: "POST",
    accessToken: user.token,
    body: { p_booking_id: bookingId },
  });
  if (!isPlainObject(result) || !validUuid(result.id)) fail(502, "booking_invalid_response", "The booking service returned an invalid response.");
  const [booking] = await attachContacts(env, user, [result]);
  return { booking };
}

async function proxyMapTile(request, env, match) {
  const zoom = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 20) fail(400, "invalid_tile", "The map tile is invalid.");
  const tileCount = 2 ** zoom;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
    fail(400, "invalid_tile", "The map tile is invalid.");
  }
  const apiKey = requireGeoapifyKey(env);
  const url = new URL(`https://maps.geoapify.com/v1/tile/osm-bright/${zoom}/${x}/${y}.png`);
  url.searchParams.set("apiKey", apiKey);
  let upstream;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  } catch {
    fail(502, "map_tile_unavailable", "The map tile could not be loaded.");
  }
  if (!upstream.ok || !upstream.headers.get("content-type")?.toLowerCase().startsWith("image/png")) {
    fail(502, "map_tile_unavailable", "The map tile could not be loaded.");
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/config" && request.method === "GET") {
    ensureSameOrigin(request);
    const config = currentConfig(env);
    if (!config) return jsonResponse({ error: { code: "configuration_incomplete", message: "Steadlane sign-in is not configured yet." } }, 503);
    return jsonResponse({ supabaseUrl: config.supabaseUrl, supabasePublishableKey: config.supabasePublishableKey });
  }

  if (path === "/api/rates" && request.method === "GET") {
    ensureSameOrigin(request);
    return jsonResponse(ratePayload(env));
  }

  const tileMatch = /^\/api\/map\/(\d{1,2})\/(\d{1,10})\/(\d{1,10})\.png$/.exec(path);
  if (tileMatch && request.method === "GET") {
    ensureSameOrigin(request);
    await enforceRateLimit(request, env, "MAP_TILE_RATE_LIMITER");
    return proxyMapTile(request, env, tileMatch);
  }

  if (!path.startsWith("/api/")) return jsonResponse({ error: { code: "not_found", message: "Not found." } }, 404);
  ensureSameOrigin(request);

  if (path === "/api/me" && request.method === "GET") {
    const user = await requireUser(request, env);
    return jsonResponse({ profile: formatProfile(user, await getProfile(user, env)) });
  }

  if (path === "/api/me" && request.method === "PATCH") {
    const user = await requireUser(request, env);
    return jsonResponse({ profile: await patchProfile(request, env, user) });
  }

  if (path === "/api/address" && request.method === "GET") {
    await enforceRateLimit(request, env, "ADDRESS_RATE_LIMITER");
    return jsonResponse(await searchAddresses(request, env));
  }

  if (path === "/api/route-quote" && request.method === "POST") {
    await enforceRateLimit(request, env, "ROUTE_RATE_LIMITER");
    const result = await createRouteQuote(request, env);
    return jsonResponse(result, result.quote.id ? 201 : 200);
  }

  if (path === "/api/driver/availability" && request.method === "GET") {
    const user = await requireUser(request, env);
    return jsonResponse(await getDriverAvailability(user, env));
  }

  if (path === "/api/driver/availability" && request.method === "PUT") {
    const user = await requireUser(request, env);
    return jsonResponse(await saveDriverAvailability(request, user, env));
  }

  if (path === "/api/recurring-bookings" && request.method === "POST") {
    const user = await requireUser(request, env);
    return jsonResponse(await createRecurringBooking(request, user, env), 201);
  }

  if (path === "/api/bookings" && request.method === "GET") {
    const user = await requireUser(request, env);
    return jsonResponse(await listBookings(request, env, user));
  }

  if (path === "/api/bookings" && request.method === "POST") {
    const user = await requireUser(request, env);
    return jsonResponse(await createBooking(request, env, user), 201);
  }

  const cancelMatch = /^\/api\/bookings\/([^/]+)\/cancel$/.exec(path);
  if (cancelMatch && request.method === "POST") {
    const user = await requireUser(request, env);
    let bookingId;
    try {
      bookingId = decodeURIComponent(cancelMatch[1]);
    } catch {
      fail(400, "invalid_booking_id", "The ride request ID is invalid.");
    }
    return jsonResponse(await cancelBooking(request, env, user, bookingId));
  }

  const cancelSeriesMatch = /^\/api\/recurring-bookings\/([^/]+)\/cancel$/.exec(path);
  if (cancelSeriesMatch && request.method === "POST") {
    const user = await requireUser(request, env);
    let seriesId;
    try {
      seriesId = decodeURIComponent(cancelSeriesMatch[1]);
    } catch {
      fail(400, "invalid_series_id", "The recurring series ID is invalid.");
    }
    return jsonResponse(await cancelRecurringBooking(user, env, seriesId));
  }

  if (path === "/api/driver-response" && request.method === "POST") {
    const user = await requireUser(request, env);
    return jsonResponse(await respondToBooking(request, env, user));
  }

  if (path.startsWith("/api/")) return jsonResponse({ error: { code: "not_found", message: "Not found." } }, 404);
  return jsonResponse({ error: { code: "method_not_allowed", message: "Method not allowed." } }, 405, { allow: "GET, POST, PATCH" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApiRequest(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
      }
      return jsonResponse({ error: { code: "internal_error", message: "The request could not be completed." } }, 500);
    }
  },
};
