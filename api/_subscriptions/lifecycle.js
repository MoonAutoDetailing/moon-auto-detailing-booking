/**
 * Subscription lifecycle: date math and cycle helpers.
 *
 * All dates are calendar dates (YYYY-MM-DD) in the business timezone (America/New_York).
 * Arithmetic is done on those strings with UTC-based Date objects so the server's timezone
 * and DST never shift a date. Convert timestamps with toNYDate() and get "today" with todayNY().
 */
import { DateTime } from "luxon";

export const BUSINESS_TZ = "America/New_York";

const WINDOW_BUSINESS_DAYS = {
  biweekly: 5,
  monthly: 5,
  quarterly: 10
};

const PUSHBACK_BUSINESS_DAYS = 5;

/** Days before window start when booking opens and the "book now" email is sent. */
export const BOOKING_OPENS_DAYS_BEFORE = 7;

/** Reminder offsets (calendar days before the effective window end). */
export const REMINDER_1_DAYS_BEFORE_END = 3;
export const REMINDER_2_DAYS_BEFORE_END = 1;

/**
 * Parse YYYY-MM-DD string to { year, month (0-based), day }.
 */
export function parseLocalDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10) - 1,
    day: parseInt(m[3], 10)
  };
}

function toUtcDate(dateStr) {
  const p = parseLocalDate(dateStr);
  if (!p) return null;
  return new Date(Date.UTC(p.year, p.month, p.day));
}

/**
 * Format { year, month (0-based), day } or a UTC-midnight Date to YYYY-MM-DD.
 */
export function formatLocalDate(obj) {
  if (!obj) return null;
  if (obj instanceof Date) {
    return `${obj.getUTCFullYear()}-${String(obj.getUTCMonth() + 1).padStart(2, "0")}-${String(obj.getUTCDate()).padStart(2, "0")}`;
  }
  if (obj.year == null || obj.month == null || obj.day == null) return null;
  return `${obj.year}-${String(obj.month + 1).padStart(2, "0")}-${String(obj.day).padStart(2, "0")}`;
}

/** Today's date in New York. `now` is injectable for tests. */
export function todayNY(now = new Date()) {
  return DateTime.fromJSDate(now).setZone(BUSINESS_TZ).toISODate();
}

/** New York calendar date of a timestamp (ISO string or Date). */
export function toNYDate(ts) {
  if (!ts) return null;
  const dt = ts instanceof Date ? DateTime.fromJSDate(ts) : DateTime.fromISO(String(ts), { setZone: true });
  if (!dt.isValid) return null;
  return dt.setZone(BUSINESS_TZ).toISODate();
}

export function addDays(dateStr, n) {
  const d = toUtcDate(dateStr);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return formatLocalDate(d);
}

/** Add n calendar months, clamping to the last day of the target month (Jan 31 + 1 = Feb 28/29). */
export function addMonthsClamped(dateStr, n) {
  const p = parseLocalDate(dateStr);
  if (!p) return null;
  const totalMonths = p.year * 12 + p.month + n;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return formatLocalDate({ year, month, day: Math.min(p.day, lastDay) });
}

/**
 * Add one cadence step to a date. biweekly = +14 days, monthly = +1 month, quarterly = +3 months
 * (month steps are clamped to month end).
 */
export function addCadence(dateStr, cadence) {
  return cadenceDate(dateStr, cadence, 1);
}

/** Anchor + `steps` cadence periods, computed from the anchor (never chained, so no drift). */
export function cadenceDate(anchorDateStr, cadence, steps) {
  if (!parseLocalDate(anchorDateStr)) return null;
  if (cadence === "biweekly") return addDays(anchorDateStr, 14 * steps);
  if (cadence === "monthly") return addMonthsClamped(anchorDateStr, steps);
  if (cadence === "quarterly") return addMonthsClamped(anchorDateStr, 3 * steps);
  return null;
}

export function isWeekend(dateStr) {
  const d = toUtcDate(dateStr);
  if (!d) return false;
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Same date if it is a weekday, otherwise the following Monday. */
export function nextBusinessDayOnOrAfter(dateStr) {
  let current = dateStr;
  while (current && isWeekend(current)) current = addDays(current, 1);
  return current;
}

/**
 * Add n business days (Mon–Fri) to dateStr. n = 0 returns dateStr.
 */
export function addBusinessDays(dateStr, n) {
  if (n <= 0) return dateStr;
  let current = dateStr;
  let added = 0;
  while (added < n) {
    current = addDays(current, 1);
    if (!current) return null;
    if (!isWeekend(current)) added += 1;
  }
  return current;
}

/**
 * Booking window length in business days for cadence.
 */
export function getCycleWindowLength(cadence) {
  return WINDOW_BUSINESS_DAYS[cadence] ?? 5;
}

/**
 * Raw cadence date for a cycle: anchor + cadence * (cycleIndex - anchorIndexBase).
 * Cycle 0 is the activation (first completed) service on the anchor date.
 */
export function getCycleStartDate(anchorDateStr, cadence, cycleIndex, anchorIndexBase = 0) {
  return cadenceDate(anchorDateStr, cadence, cycleIndex - (anchorIndexBase || 0));
}

/**
 * Last day of a window that starts on startDate: the window covers N business days
 * including the start day (5 → Mon–Fri when it starts on a Monday).
 */
export function getCycleEndDate(startDate, frequency) {
  const n = getCycleWindowLength(frequency);
  return addBusinessDays(nextBusinessDayOnOrAfter(startDate), n - 1);
}

/**
 * Full window for a cycle: start rolls forward to Monday if the cadence date is a weekend.
 * Returns { start, end, opensOn } (all YYYY-MM-DD) or null.
 */
export function computeCycleWindow(anchorDateStr, cadence, cycleIndex, anchorIndexBase = 0) {
  const raw = getCycleStartDate(anchorDateStr, cadence, cycleIndex, anchorIndexBase);
  if (!raw) return null;
  const start = nextBusinessDayOnOrAfter(raw);
  const end = getCycleEndDate(start, cadence);
  return { start, end, opensOn: getBookingOpensDate(start) };
}

/** Date booking opens (and the "book now" email goes out) for a window starting on startDate. */
export function getBookingOpensDate(startDate) {
  return addDays(startDate, -BOOKING_OPENS_DAYS_BEFORE);
}

/** Reminder dates relative to a cycle's effective end. */
export function getReminderDates(effectiveEnd) {
  return {
    reminder1: addDays(effectiveEnd, -REMINDER_1_DAYS_BEFORE_END),
    reminder2: addDays(effectiveEnd, -REMINDER_2_DAYS_BEFORE_END)
  };
}

/** End of a pushback/extension that starts from `fromDate` (+5 business days). */
export function getPushbackEnd(fromDate) {
  return addBusinessDays(fromDate, PUSHBACK_BUSINESS_DAYS);
}

/**
 * Next cycle index = max(cycle_index) + 1, or 1 if none.
 */
export function getNextCycleSequence(maxSequence) {
  if (maxSequence == null || maxSequence === undefined) return 1;
  const m = parseInt(maxSequence, 10);
  return Number.isFinite(m) ? m + 1 : 1;
}

/**
 * Effective window end: pushback_end_date if pushback_used, else window_end_date.
 */
export function getEffectiveWindowEnd(cycle) {
  if (cycle.pushback_used && cycle.pushback_end_date) {
    return cycle.pushback_end_date;
  }
  return cycle.window_end_date || null;
}

export function isCycleUnresolved(cycle) {
  return cycle && (cycle.status === "open" || cycle.status === "booked");
}

export function isCycleResolved(cycle) {
  return cycle && (cycle.status === "completed" || cycle.status === "missed" || cycle.status === "void");
}

/**
 * Whether to apply discount reset: subscription has discount_reset_required and cycle is completing.
 */
export function shouldApplyDiscountReset(subscription) {
  return subscription && subscription.discount_reset_required === true;
}

export { PUSHBACK_BUSINESS_DAYS };
