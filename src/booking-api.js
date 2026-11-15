function apiError(payload, status) {
  const message = payload?.error?.message || payload?.message || payload?.error;
  if (typeof message === "string" && message.length <= 300) return new Error(message);
  if (status === 401) return new Error("Please sign in again to continue.");
  if (status === 403) return new Error("You do not have permission to do that.");
  return new Error("The request could not be completed. Try again.");
}

async function readResponse(response) {
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("The service returned an unreadable response.");
    }
  }
  if (!response.ok) throw apiError(payload, response.status);
  return payload;
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  return {
    id: profile.id,
    email: profile.email ?? null,
    role: profile.role,
    fullName: profile.full_name ?? profile.fullName ?? null,
    phone: profile.phone ?? null,
    createdAt: profile.created_at ?? profile.createdAt ?? null,
  };
}

function normalizeBooking(row) {
  if (!row || typeof row !== "object") return null;
  const fareTotalCents = row.fare_total_cents;
  const fareTotal = row.fareTotal ?? (
    Number.isFinite(Number(fareTotalCents)) ? Number(fareTotalCents) / 100 : null
  );
  const fareStopCents = row.fare_stop_cents ?? row.fareStopCents;
  const databaseStatus = row.status;
  const status = databaseStatus === "assigned" ? "accepted" : databaseStatus;
  const stops = Array.isArray(row.stops) ? row.stops : [];

  return {
    id: row.id,
    pickupLabel: row.pickup_label ?? row.pickupLabel ?? "",
    destinationLabel: row.destination_label ?? row.destinationLabel ?? "",
    pickupAt: row.pickup_at ?? row.pickupAt ?? null,
    recurringSeriesId: row.recurring_series_id ?? row.recurringSeriesId ?? null,
    stops: stops.map((stop) => ({
      placeId: stop?.place_id ?? stop?.placeId ?? null,
      label: stop?.label ?? "",
      latitude: Number(stop?.latitude ?? stop?.lat),
      longitude: Number(stop?.longitude ?? stop?.lon),
    })),
    passengerCount: Number(row.passenger_count ?? row.passengerCount),
    distanceMiles: Number(row.distance_miles ?? row.distanceMiles),
    durationMinutes: Number(row.duration_minutes ?? row.durationMinutes),
    fareTotal,
    stopCount: Number(row.stop_count ?? row.stopCount ?? row.stops?.length ?? 0),
    stopCharge: fareStopCents === null || fareStopCents === undefined
      ? null
      : Number(fareStopCents) / 100,
    currency: row.currency || "USD",
    status,
    driverId: row.assigned_driver_id ?? row.driver_id ?? row.driverId ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    passengerName: row.passenger_name ?? row.passengerName ?? null,
    passengerPhone: row.passenger_phone ?? row.passengerPhone ?? null,
    routeGeometry: row.route_geometry ?? row.routeGeometry ?? null,
  };
}

function normalizeSeries(series) {
  if (!series || typeof series !== "object") return null;
  return {
    id: series.id,
    status: series.status,
    weekdays: Array.isArray(series.weekdays) ? series.weekdays.map(Number) : [],
    startDate: series.start_date ?? series.startDate ?? null,
    endDate: series.end_date ?? series.endDate ?? null,
    pickupTime: series.pickup_time ?? series.pickupTime ?? null,
    timeZone: series.time_zone ?? series.timeZone ?? "America/New_York",
    createdAt: series.created_at ?? series.createdAt ?? null,
    cancelledAt: series.cancelled_at ?? series.cancelledAt ?? null,
  };
}

function normalizeAvailability(availability) {
  if (!Array.isArray(availability)) return [];
  return availability.map((window) => ({
    dayOfWeek: Number(window.dayOfWeek ?? window.day_of_week),
    startTime: window.startTime ?? window.start_time,
    endTime: window.endTime ?? window.end_time,
  }));
}

/**
 * Create a same-origin client for Steadlane's authenticated Worker API.
 * Auth tokens are fetched just before each call and are never put in URLs.
 */
export function createBookingApi(authClient) {
  if (authClient !== null && authClient !== undefined && typeof authClient.getAccessToken !== "function") {
    throw new TypeError("A Steadlane auth client is required when one is provided.");
  }

  async function request(path, { method = "GET", body, signal, auth = "required" } = {}) {
    if (typeof window === "undefined") throw new Error("The booking API is available in a browser.");
    const target = new URL(path, window.location.origin);
    if (target.origin !== window.location.origin) {
      throw new TypeError("Booking API requests must stay on this site.");
    }

    let token = null;
    if (authClient) {
      try {
        token = await authClient.getAccessToken();
      } catch (error) {
        if (auth !== "optional") throw error;
      }
    }
    if (auth === "required" && !token) throw new Error("Sign in to continue.");

    const headers = new Headers({ accept: "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    let response;
    try {
      response = await fetch(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new Error("Could not reach Steadlane. Check your connection and try again.");
    }
    return readResponse(response);
  }

  return Object.freeze({
    async getPricing() {
      return request("/api/rates", { auth: "optional" });
    },

    async getProfile() {
      const payload = await request("/api/me");
      return normalizeProfile(payload?.profile);
    },

    async updateProfile({ fullName, phone }) {
      const payload = await request("/api/me", {
        method: "PATCH",
        body: { fullName, phone },
      });
      return normalizeProfile(payload?.profile);
    },

    async searchAddresses(query, { signal } = {}) {
      const params = new URLSearchParams({ q: String(query ?? "") });
      const payload = await request(`/api/address?${params}`, { signal, auth: "optional" });
      return { suggestions: Array.isArray(payload?.suggestions) ? payload.suggestions : [] };
    },

    async createRouteQuote(input) {
      const payload = await request("/api/route-quote", { method: "POST", body: input, auth: "optional" });
      return payload?.quote ?? null;
    },

    async createBooking({ quoteId, idempotencyKey }) {
      const payload = await request("/api/bookings", {
        method: "POST",
        body: { quoteId, idempotencyKey },
      });
      return { booking: normalizeBooking(payload?.booking) };
    },

    async listBookings() {
      const payload = await request("/api/bookings?limit=50");
      const bookings = Array.isArray(payload?.bookings) ? payload.bookings : [];
      return bookings.map(normalizeBooking).filter(Boolean);
    },

    async cancelBooking({ bookingId }) {
      const payload = await request(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, {
        method: "POST",
        body: {},
      });
      return { booking: normalizeBooking(payload?.booking) };
    },

    async respondToBooking({ bookingId, decision }) {
      const payload = await request("/api/driver-response", {
        method: "POST",
        body: { bookingId, decision },
      });
      return { booking: normalizeBooking(payload?.booking) };
    },

    async getDriverAvailability() {
      const payload = await request("/api/driver/availability");
      return normalizeAvailability(payload?.availability);
    },

    async saveDriverAvailability({ availability }) {
      const payload = await request("/api/driver/availability", {
        method: "PUT",
        body: { availability },
      });
      return normalizeAvailability(payload?.availability);
    },

    async createRecurringBooking({ quoteId, idempotencyKey, weekdays, startDate, endDate, pickupTime }) {
      const payload = await request("/api/recurring-bookings", {
        method: "POST",
        body: { quoteId, idempotencyKey, weekdays, startDate, endDate, pickupTime },
      });
      const bookings = Array.isArray(payload?.bookings) ? payload.bookings : [];
      return {
        series: normalizeSeries(payload?.series),
        bookings: bookings.map(normalizeBooking).filter(Boolean),
      };
    },

    async cancelRecurringBooking({ seriesId }) {
      const payload = await request(`/api/recurring-bookings/${encodeURIComponent(seriesId)}/cancel`, {
        method: "POST",
        body: {},
      });
      return { series: normalizeSeries(payload?.series) };
    },
  });
}
