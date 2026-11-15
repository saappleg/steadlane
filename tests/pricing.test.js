import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateFare,
  calculateFareBreakdown,
  DEFAULT_RATES,
} from "../src/pricing.js";

test("distance and duration are priced with the documented rates", () => {
  assert.equal(calculateFare({ distanceMiles: 10, durationMinutes: 20 }), 28);
});

test("the minimum fare and booking fee apply to a zero-length trip", () => {
  const breakdown = calculateFareBreakdown({ distanceMiles: 0, durationMinutes: 0 });

  assert.deepEqual(breakdown, {
    baseFare: 3,
    distanceCharge: 0,
    durationCharge: 0,
    minimumAdjustment: 5,
    bookingFee: 1,
    total: 9,
  });
});

test("fare breakdown components add up to the total above the minimum", () => {
  const breakdown = calculateFareBreakdown({ distanceMiles: 10, durationMinutes: 20 });

  assert.equal(breakdown.baseFare, 3);
  assert.equal(breakdown.distanceCharge, 18);
  assert.equal(breakdown.durationCharge, 6);
  assert.equal(breakdown.minimumAdjustment, 0);
  assert.equal(breakdown.bookingFee, 1);
  assert.equal(breakdown.total, 28);
});

test("custom rates are supported without changing the defaults", () => {
  const rates = {
    baseFare: 4,
    perMile: 2,
    perMinute: 0.5,
    minimumFare: 10,
    bookingFee: 2,
  };

  assert.equal(calculateFare({ distanceMiles: 3, durationMinutes: 4 }, rates), 14);
  assert.deepEqual(DEFAULT_RATES, {
    baseFare: 3,
    perMile: 1.8,
    perMinute: 0.3,
    minimumFare: 8,
    bookingFee: 1,
  });
});

test("fare totals are rounded to cents", () => {
  const rates = {
    baseFare: 0,
    perMile: 0.005,
    perMinute: 0,
    minimumFare: 0,
    bookingFee: 0,
  };

  assert.equal(calculateFare({ distanceMiles: 1, durationMinutes: 0 }, rates), 0.01);
});

test("rejects missing or malformed trip details", () => {
  for (const trip of [undefined, null, [], "trip"]) {
    assert.throws(() => calculateFare(trip), /Trip details must be provided as an object/);
  }

  for (const trip of [
    { distanceMiles: -1, durationMinutes: 10 },
    { distanceMiles: 10, durationMinutes: -1 },
    { distanceMiles: "10", durationMinutes: 10 },
    { distanceMiles: 10, durationMinutes: NaN },
    { distanceMiles: Infinity, durationMinutes: 10 },
  ]) {
    assert.throws(() => calculateFare(trip), /Fare inputs must be finite, nonnegative numbers/);
  }
});

test("rejects missing or malformed custom rates", () => {
  const validRates = { ...DEFAULT_RATES };

  for (const rates of [null, [], "rates", { ...validRates, perMile: -1 }, { ...validRates, perMinute: Infinity }, { ...validRates, bookingFee: "1" }]) {
    assert.throws(
      () => calculateFare({ distanceMiles: 1, durationMinutes: 1 }, rates),
      /Fare rates must be provided as an object|Fare rates must be finite, nonnegative numbers/,
    );
  }

  const missingRate = { ...validRates };
  delete missingRate.bookingFee;
  assert.throws(
    () => calculateFare({ distanceMiles: 1, durationMinutes: 1 }, missingRate),
    /Fare rates must be finite, nonnegative numbers/,
  );
});

test("rejects calculations that overflow the supported amount range", () => {
  assert.throws(
    () => calculateFare({ distanceMiles: Number.MAX_VALUE, durationMinutes: 0 }),
    /Fare total exceeds the supported calculation range/,
  );
});
