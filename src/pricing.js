export const DEFAULT_RATES = Object.freeze({
  baseFare: 3,
  perMile: 1.8,
  perMinute: 0.3,
  minimumFare: 8,
  bookingFee: 1,
});

const RATE_KEYS = Object.freeze([
  "baseFare",
  "perMile",
  "perMinute",
  "minimumFare",
  "bookingFee",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTrip(trip) {
  if (!isRecord(trip)) {
    throw new Error("Trip details must be provided as an object");
  }

  const { distanceMiles, durationMinutes } = trip;
  if (
    !Number.isFinite(distanceMiles) ||
    !Number.isFinite(durationMinutes) ||
    distanceMiles < 0 ||
    durationMinutes < 0
  ) {
    throw new Error("Fare inputs must be finite, nonnegative numbers");
  }

  return { distanceMiles, durationMinutes };
}

function validateRates(rates) {
  if (!isRecord(rates)) {
    throw new Error("Fare rates must be provided as an object");
  }

  for (const key of RATE_KEYS) {
    const value = rates[key];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Fare rates must be finite, nonnegative numbers");
    }
  }

  return rates;
}

function ensureFiniteAmount(amount) {
  if (!Number.isFinite(amount)) {
    throw new Error("Fare total exceeds the supported calculation range");
  }
  return amount;
}

/**
 * Calculate an illustrative fare breakdown from a known route distance and
 * duration. A client-side result is a preview, not a final booked fare.
 */
export function calculateFareBreakdown(trip, rates = DEFAULT_RATES) {
  const { distanceMiles, durationMinutes } = validateTrip(trip);
  validateRates(rates);

  const distanceCharge = ensureFiniteAmount(distanceMiles * rates.perMile);
  const durationCharge = ensureFiniteAmount(durationMinutes * rates.perMinute);
  const rawSubtotal = ensureFiniteAmount(
    rates.baseFare + distanceCharge + durationCharge,
  );
  const minimumAdjustment = Math.max(0, rates.minimumFare - rawSubtotal);
  const subtotal = Math.max(rates.minimumFare, rawSubtotal);
  const unroundedTotal = ensureFiniteAmount(subtotal + rates.bookingFee);
  const amountInCents = ensureFiniteAmount((unroundedTotal + Number.EPSILON) * 100);
  const total = Math.round(amountInCents) / 100;

  return {
    baseFare: rates.baseFare,
    distanceCharge,
    durationCharge,
    minimumAdjustment,
    bookingFee: rates.bookingFee,
    total,
  };
}

export function calculateFare(trip, rates = DEFAULT_RATES) {
  return calculateFareBreakdown(trip, rates).total;
}
