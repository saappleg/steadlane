export const WEEKLY_SCHEDULE_TIME_ZONE = "America/New_York";
export const MAX_WEEKLY_SCHEDULE_DAYS = 90;

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const ISO_WEEKDAYS = new Set([1, 2, 3, 4, 5, 6, 7]);
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const NEW_YORK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  calendar: "gregory",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  numberingSystem: "latn",
  timeZone: WEEKLY_SCHEDULE_TIME_ZONE,
  year: "numeric",
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readOwnDataProperty(record, key) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    throw new TypeError(`Weekly schedule field ${key} is invalid.`);
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`Weekly schedule field ${key} is required as a data value.`);
  }
  return descriptor.value;
}

function readOptionalDataProperty(record, key) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    throw new TypeError(`Weekly schedule field ${key} is invalid.`);
  }
  if (descriptor !== undefined && !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`Weekly schedule field ${key} is invalid.`);
  }
  return descriptor;
}

function parseLocalDate(value, name) {
  if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value)) {
    throw new TypeError(`${name} must use YYYY-MM-DD format.`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${name} must be a valid calendar date.`);
  }
  return timestamp;
}

function utcFromParts({ year, month, day, hour = 0, minute = 0 }) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getTime();
}

function getZonedParts(timestamp) {
  const parts = Object.fromEntries(
    NEW_YORK_FORMATTER.formatToParts(new Date(timestamp))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function sameLocalDateTime(left, right) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function hasOneNewYorkInstant(dateParts, timeParts) {
  const target = { ...dateParts, ...timeParts };
  const targetAsUtc = utcFromParts(target);
  const candidateOffsets = new Set();

  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sampleTimestamp = targetAsUtc + hours * 60 * 60 * 1000;
    const sampleWallTime = getZonedParts(sampleTimestamp);
    const sampleWallAsUtc = utcFromParts(sampleWallTime);
    candidateOffsets.add((sampleWallAsUtc - sampleTimestamp) / 60_000);
  }

  const matchingInstants = new Set();
  for (const offsetMinutes of candidateOffsets) {
    const candidateTimestamp = targetAsUtc - offsetMinutes * 60_000;
    if (sameLocalDateTime(getZonedParts(candidateTimestamp), target)) {
      matchingInstants.add(candidateTimestamp);
    }
  }
  return matchingInstants.size === 1;
}

function parseLocalTime(value) {
  if (typeof value !== "string" || !LOCAL_TIME_PATTERN.test(value)) {
    throw new TypeError("Pickup time must use 24-hour HH:mm format.");
  }
  const [hour, minute] = value.split(":").map(Number);
  return { hour, minute };
}

function validateSelectedWeekdays(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Choose one or more ISO weekdays from 1 to 7.");
  }

  const weekdays = new Set();
  for (const weekday of value) {
    if (!Number.isInteger(weekday) || !ISO_WEEKDAYS.has(weekday)) {
      throw new TypeError("Weekdays must be unique ISO weekday numbers from 1 to 7.");
    }
    if (weekdays.has(weekday)) {
      throw new TypeError("Weekdays must be unique ISO weekday numbers from 1 to 7.");
    }
    weekdays.add(weekday);
  }
  return [...weekdays].sort((left, right) => left - right);
}

/**
 * Validate a weekly schedule whose dates and pickupTime use New York local time.
 * Dates are inclusive, and weekdays use ISO numbering (Monday=1, Sunday=7).
 */
export function validateWeeklySchedule(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("Weekly schedule must be a plain object.");
  }

  const weekdays = validateSelectedWeekdays(readOwnDataProperty(input, "weekdays"));
  const startDate = readOwnDataProperty(input, "startDate");
  const endDate = readOwnDataProperty(input, "endDate");
  const pickupTime = readOwnDataProperty(input, "pickupTime");
  const startTimestamp = parseLocalDate(startDate, "Start date");
  const endTimestamp = parseLocalDate(endDate, "End date");
  if (endTimestamp < startTimestamp) {
    throw new TypeError("End date must be on or after start date.");
  }

  const daySpan = (endTimestamp - startTimestamp) / DAY_MILLISECONDS;
  if (daySpan + 1 > MAX_WEEKLY_SCHEDULE_DAYS) {
    throw new TypeError("Weekly schedule cannot cover more than 90 inclusive calendar days.");
  }

  const timeZoneDescriptor = readOptionalDataProperty(input, "timeZone");
  if (
    timeZoneDescriptor &&
    timeZoneDescriptor.value !== WEEKLY_SCHEDULE_TIME_ZONE
  ) {
    throw new TypeError("Time zone must be America/New_York.");
  }

  const timeParts = parseLocalTime(pickupTime);
  const selectedDays = new Set(weekdays);
  let occurrenceFound = false;
  for (let dayOffset = 0; dayOffset <= daySpan; dayOffset += 1) {
    const timestamp = startTimestamp + dayOffset * DAY_MILLISECONDS;
    const date = new Date(timestamp);
    const jsWeekday = date.getUTCDay();
    const isoWeekday = jsWeekday === 0 ? 7 : jsWeekday;
    if (!selectedDays.has(isoWeekday)) continue;

    occurrenceFound = true;
    const dateParts = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
    if (!hasOneNewYorkInstant(dateParts, timeParts)) {
      throw new TypeError(
        `Pickup time is ambiguous or does not exist on ${date.toISOString().slice(0, 10)} in America/New_York.`,
      );
    }
  }

  if (!occurrenceFound) {
    throw new TypeError("The date range contains none of the selected weekdays.");
  }

  return {
    weekdays,
    startDate,
    endDate,
    pickupTime,
    timeZone: WEEKLY_SCHEDULE_TIME_ZONE,
  };
}
