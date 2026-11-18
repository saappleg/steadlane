export const DEFAULT_RATES = Object.freeze({
  baseFare: 3,
  perMile: 1.8,
  perMinute: 0.3,
  minimumFare: 8,
  bookingFee: 1,
  stopFeePerStop: null,
});

const RATE_KEYS = Object.freeze([
  "baseFare",
  "perMile",
  "perMinute",
  "minimumFare",
  "bookingFee",
]);

function isRecord(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }

  try {
    if (Array.isArray(value)) {
      return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readNonnegativeNumber(record, key, errorMessage) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    throw new Error(errorMessage);
  }

  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    !Number.isFinite(descriptor.value) ||
    descriptor.value < 0
  ) {
    throw new Error(errorMessage);
  }

  return descriptor.value;
}

function readOptionalDataProperty(record, key, errorMessage) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    throw new Error(errorMessage);
  }

  if (descriptor !== undefined && !Object.hasOwn(descriptor, "value")) {
    throw new Error(errorMessage);
  }
  return descriptor;
}

function validateTrip(trip) {
  if (!isRecord(trip)) {
    throw new Error("Trip details must be provided as an object");
  }

  const errorMessage = "Fare inputs must be finite, nonnegative numbers";
  const distanceMiles = readNonnegativeNumber(trip, "distanceMiles", errorMessage);
  const durationMinutes = readNonnegativeNumber(trip, "durationMinutes", errorMessage);
  const stopCountDescriptor = readOptionalDataProperty(trip, "stopCount", errorMessage);
  const stopCount = stopCountDescriptor === undefined ? 0 : stopCountDescriptor.value;
  if (!Number.isSafeInteger(stopCount) || stopCount < 0 || stopCount > 3) {
    throw new Error("Stop count must be an integer from 0 to 3");
  }
  return { distanceMiles, durationMinutes, stopCount };
}

function validateRates(rates) {
  if (!isRecord(rates)) {
    throw new Error("Fare rates must be provided as an object");
  }

  const errorMessage = "Fare rates must be finite, nonnegative numbers";
  const validatedRates = {};
  for (const key of RATE_KEYS) {
    validatedRates[key] = readNonnegativeNumber(rates, key, errorMessage);
  }

  const stopFeeDescriptor = readOptionalDataProperty(rates, "stopFeePerStop", errorMessage);
  const stopFeePerStop = stopFeeDescriptor === undefined
    ? null
    : stopFeeDescriptor.value;
  if (
    stopFeePerStop !== null &&
    (!Number.isFinite(stopFeePerStop) || stopFeePerStop < 0)
  ) {
    throw new Error("Stop fee must be null or a finite, nonnegative number");
  }
  validatedRates.stopFeePerStop = stopFeePerStop;

  return validatedRates;
}

function ensureFiniteAmount(amount) {
  if (!Number.isFinite(amount)) {
    throw new Error("Fare total exceeds the supported calculation range");
  }
  return amount;
}

function roundFareToCents(amount) {
  const amountInCents = ensureFiniteAmount(amount * 100);
  const maxSupportedCents = 1 / (2 * Number.EPSILON);
  if (amountInCents > maxSupportedCents) {
    throw new Error("Fare total exceeds the supported calculation range");
  }
  const roundingTolerance = Number.EPSILON * Math.max(1, Math.abs(amountInCents));
  const roundedCents = Math.round(amountInCents + roundingTolerance);
  if (!Number.isSafeInteger(roundedCents)) {
    throw new Error("Fare total exceeds the supported calculation range");
  }
  return roundedCents / 100;
}

/**
 * Calculate an illustrative fare breakdown from validated route distance,
 * duration, and stop count. Stop fees are incomplete unless configured. The
 * server-side calculation is authoritative; any client-side result is only a
 * preview.
 */
export function calculateFareBreakdown(trip, rates = DEFAULT_RATES) {
  const { distanceMiles, durationMinutes, stopCount } = validateTrip(trip);
  const validatedRates = validateRates(rates);

  const distanceCharge = ensureFiniteAmount(distanceMiles * validatedRates.perMile);
  const durationCharge = ensureFiniteAmount(durationMinutes * validatedRates.perMinute);
  const knownRawSubtotal = ensureFiniteAmount(
    validatedRates.baseFare + distanceCharge + durationCharge,
  );
  const knownMinimumAdjustment = Math.max(0, validatedRates.minimumFare - knownRawSubtotal);
  const knownSubtotal = roundFareToCents(
    Math.max(validatedRates.minimumFare, knownRawSubtotal) + validatedRates.bookingFee,
  );

  const stopCharge = stopCount === 0
    ? 0
    : validatedRates.stopFeePerStop === null
      ? null
      : ensureFiniteAmount(stopCount * validatedRates.stopFeePerStop);
  const bookable = stopCharge !== null;

  let minimumAdjustment = knownMinimumAdjustment;
  let total = null;
  if (bookable) {
    const rawSubtotal = ensureFiniteAmount(knownRawSubtotal + stopCharge);
    minimumAdjustment = Math.max(0, validatedRates.minimumFare - rawSubtotal);
    const subtotal = Math.max(validatedRates.minimumFare, rawSubtotal);
    const unroundedTotal = ensureFiniteAmount(subtotal + validatedRates.bookingFee);
    total = roundFareToCents(unroundedTotal);
  }

  return {
    baseFare: validatedRates.baseFare,
    distanceCharge,
    durationCharge,
    minimumAdjustment,
    bookingFee: validatedRates.bookingFee,
    stopCount,
    stopCharge,
    knownSubtotal,
    bookable,
    total,
  };
}

export function calculateFare(trip, rates = DEFAULT_RATES) {
  const breakdown = calculateFareBreakdown(trip, rates);
  if (!breakdown.bookable) {
    throw new Error("Fare cannot be finalized until stop pricing is configured");
  }
  return breakdown.total;
}
