import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WEEKLY_SCHEDULE_DAYS,
  WEEKLY_SCHEDULE_TIME_ZONE,
  validateWeeklySchedule,
} from "../src/scheduling.js";

function schedule(overrides = {}) {
  return {
    weekdays: [1, 5],
    startDate: "2026-11-16",
    endDate: "2026-11-27",
    pickupTime: "09:30",
    ...overrides,
  };
}

test("normalizes a weekly schedule using New York local time", () => {
  assert.deepEqual(validateWeeklySchedule(schedule({ weekdays: [5, 1] })), {
    weekdays: [1, 5],
    startDate: "2026-11-16",
    endDate: "2026-11-27",
    pickupTime: "09:30",
    timeZone: WEEKLY_SCHEDULE_TIME_ZONE,
  });
});

test("accepts a maximum 90 inclusive calendar-day window", () => {
  assert.equal(MAX_WEEKLY_SCHEDULE_DAYS, 90);
  const result = validateWeeklySchedule({
    weekdays: [4],
    startDate: "2026-01-01",
    endDate: "2026-03-31",
    pickupTime: "12:00",
  });
  assert.equal(result.startDate, "2026-01-01");
  assert.equal(result.endDate, "2026-03-31");
});

test("rejects date windows longer than 90 inclusive days", () => {
  assert.throws(
    () => validateWeeklySchedule({
      weekdays: [4],
      startDate: "2026-01-01",
      endDate: "2026-04-01",
      pickupTime: "12:00",
    }),
    /more than 90 inclusive calendar days/,
  );
});

test("requires unique ISO weekday numbers and at least one matching date", () => {
  for (const weekdays of [[], [1, 1], [0], [8], ["1"], null]) {
    assert.throws(
      () => validateWeeklySchedule(schedule({ weekdays })),
      /weekday|Weekday|weekdays/i,
    );
  }

  assert.throws(
    () => validateWeeklySchedule(schedule({
      weekdays: [1],
      startDate: "2026-11-15",
      endDate: "2026-11-15",
    })),
    /none of the selected weekdays/,
  );
});

test("requires valid inclusive dates and local 24-hour pickup time", () => {
  for (const invalid of [
    { startDate: "2026-02-30" },
    { startDate: "2026-2-03" },
    { endDate: "2026-11-15" },
    { pickupTime: "9:30" },
    { pickupTime: "24:00" },
    { pickupTime: "12:60" },
    { pickupTime: "9:30 AM" },
  ]) {
    assert.throws(() => validateWeeklySchedule(schedule(invalid)));
  }
});

test("rejects a time zone other than America/New_York", () => {
  assert.throws(
    () => validateWeeklySchedule(schedule({ timeZone: "UTC" })),
    /Time zone must be America\/New_York/,
  );
});

test("rejects nonexistent or ambiguous local pickup times during DST changes", () => {
  assert.throws(
    () => validateWeeklySchedule({
      weekdays: [7],
      startDate: "2026-03-08",
      endDate: "2026-03-08",
      pickupTime: "02:30",
    }),
    /ambiguous or does not exist/,
  );

  assert.throws(
    () => validateWeeklySchedule({
      weekdays: [7],
      startDate: "2026-11-01",
      endDate: "2026-11-01",
      pickupTime: "01:30",
    }),
    /ambiguous or does not exist/,
  );
});

test("does not invoke accessor fields while validating a schedule", () => {
  let getterCalled = false;
  const input = schedule();
  Object.defineProperty(input, "pickupTime", {
    get() {
      getterCalled = true;
      return "09:30";
    },
  });

  assert.throws(() => validateWeeklySchedule(input), /pickupTime/);
  assert.equal(getterCalled, false);
});
