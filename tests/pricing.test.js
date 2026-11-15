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
    stopCount: 0,
    stopCharge: 0,
    knownSubtotal: 9,
    bookable: true,
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
    stopFeePerStop: null,
  });
});

test("stops without configured pricing return an incomplete non-bookable fare", () => {
  const trip = { distanceMiles: 10, durationMinutes: 20, stopCount: 2 };
  const breakdown = calculateFareBreakdown(trip);

  assert.equal(breakdown.stopCount, 2);
  assert.equal(breakdown.stopCharge, null);
  assert.equal(breakdown.knownSubtotal, 28);
  assert.equal(breakdown.bookable, false);
  assert.equal(breakdown.total, null);
  assert.throws(
    () => calculateFare(trip),
    /Fare cannot be finalized until stop pricing is configured/,
  );
});

test("explicit stop rates add to the fare before applying the minimum", () => {
  const rates = { ...DEFAULT_RATES, stopFeePerStop: 1.75 };
  const trip = { distanceMiles: 10, durationMinutes: 20, stopCount: 2 };
  const breakdown = calculateFareBreakdown(trip, rates);

  assert.equal(breakdown.stopCharge, 3.5);
  assert.equal(breakdown.knownSubtotal, 28);
  assert.equal(breakdown.minimumAdjustment, 0);
  assert.equal(breakdown.bookable, true);
  assert.equal(breakdown.total, 31.5);
  assert.equal(calculateFare(trip, rates), 31.5);
});

test("configured stop fees can be absorbed by the minimum fare", () => {
  const rates = { ...DEFAULT_RATES, stopFeePerStop: 1 };
  const breakdown = calculateFareBreakdown(
    { distanceMiles: 0, durationMinutes: 0, stopCount: 2 },
    rates,
  );

  assert.equal(breakdown.stopCharge, 2);
  assert.equal(breakdown.minimumAdjustment, 3);
  assert.equal(breakdown.total, 9);
});

test("rejects stop counts outside the supported range", () => {
  for (const stopCount of [-1, 1.5, "1", 4, Infinity, NaN]) {
    assert.throws(
      () => calculateFareBreakdown({ distanceMiles: 1, durationMinutes: 1, stopCount }),
      /Stop count must be an integer from 0 to 3/,
    );
  }
});

test("rejects malformed configured stop fees", () => {
  for (const stopFeePerStop of [-1, Infinity, "1", undefined]) {
    assert.throws(
      () => calculateFareBreakdown(
        { distanceMiles: 1, durationMinutes: 1, stopCount: 1 },
        { ...DEFAULT_RATES, stopFeePerStop },
      ),
      /Stop fee must be null or a finite, nonnegative number/,
    );
  }
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

test("fare rounding handles binary floating-point half-cent values", () => {
  const rates = {
    baseFare: 150.075,
    perMile: 0,
    perMinute: 0,
    minimumFare: 0,
    bookingFee: 0,
  };

  assert.equal(calculateFare({ distanceMiles: 0, durationMinutes: 0 }, rates), 150.08);
});

test("rejects fare totals whose rounded cents exceed the safe integer range", () => {
  const rates = {
    baseFare: (Number.MAX_SAFE_INTEGER + 1) / 100,
    perMile: 0,
    perMinute: 0,
    minimumFare: 0,
    bookingFee: 0,
  };

  assert.throws(
    () => calculateFare({ distanceMiles: 0, durationMinutes: 0 }, rates),
    /Fare total exceeds the supported calculation range/,
  );
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
    { distanceMiles: 10, durationMinutes: Number.NEGATIVE_INFINITY },
    { distanceMiles: 10n, durationMinutes: 10 },
  ]) {
    assert.throws(() => calculateFare(trip), /Fare inputs must be finite, nonnegative numbers/);
  }
});

test("route metrics must be own data properties on a plain object", () => {
  const inheritedMetrics = Object.create({ distanceMiles: 10, durationMinutes: 10 });
  assert.throws(
    () => calculateFare(inheritedMetrics),
    /Trip details must be provided as an object/,
  );

  let getterCalled = false;
  const accessorMetrics = {
    get distanceMiles() {
      getterCalled = true;
      return 10;
    },
    durationMinutes: 10,
  };
  assert.throws(
    () => calculateFare(accessorMetrics),
    /Fare inputs must be finite, nonnegative numbers/,
  );
  assert.equal(getterCalled, false);
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

test("custom rate values must be own data properties on a plain object", () => {
  const inheritedRates = Object.create(DEFAULT_RATES);
  assert.throws(
    () => calculateFare({ distanceMiles: 1, durationMinutes: 1 }, inheritedRates),
    /Fare rates must be provided as an object/,
  );

  let getterCalled = false;
  const accessorRates = {
    ...DEFAULT_RATES,
    get perMile() {
      getterCalled = true;
      return DEFAULT_RATES.perMile;
    },
  };
  assert.throws(
    () => calculateFare({ distanceMiles: 1, durationMinutes: 1 }, accessorRates),
    /Fare rates must be finite, nonnegative numbers/,
  );
  assert.equal(getterCalled, false);
});

test("rejects calculations that overflow the supported amount range", () => {
  assert.throws(
    () => calculateFare({ distanceMiles: Number.MAX_VALUE, durationMinutes: 0 }),
    /Fare total exceeds the supported calculation range/,
  );
});
