/**
 * Subscription lifecycle: date math and cycle helpers.
 * All calculations use local date (YYYY-MM-DD) logic. Do not rely on timestamps.
 */

const CADENCE_DAYS = {
  biweekly: 14,
  monthly: null,
  quarterly: null
};

const WINDOW_BUSINESS_DAYS = {
  biweekly: 5,
  monthly: 5,
  quarterly: 10
};

const PUSHBACK_BUSINESS_DAYS = 5;

/**
 * Parse YYYY-MM-DD string to { year, month, day } (local calendar).
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

/**
 * Format { year, month, day } or Date to YYYY-MM-DD.
 */
export function formatLocalDate(obj) {
  if (!obj) return null;
  if (typeof obj.toISOString === "function") {
    return obj.toISOString().slice(0, 10);
  }
  if (obj.year == null || obj.month == null || obj.day == null) return null;
  const month = (obj.month + 1).toString().padStart(2, "0");
  const day = obj.day.toString().padStart(2, "0");
  return `${obj.year}-${month}-${day}`;
}

/**
 * Add cadence to a local date string. Returns YYYY-MM-DD.
 * biweekly = +14 days, monthly = +1 calendar month, quarterly = +3 calendar months.
 */
export function addCadence(dateStr, cadence) {
  const p = parseLocalDate(dateStr);
  if (!p || !cadence) return null;
  if (cadence === "biweekly") {
    const d = new Date(p.year, p.month, p.day);
    d.setDate(d.getDate() + CADENCE_DAYS.biweekly);
    return formatLocalDate(d);
  }
  if (cadence === "monthly") {
    const d = new Date(p.year, p.month, p.day);
    d.setMonth(d.getMonth() + 1);
    return formatLocalDate(d);
  }
  if (cadence === "quarterly") {
    const d = new Date(p.year, p.month, p.day);
    d.setMonth(d.getMonth() + 3);
    return formatLocalDate(d);
  }
  return null;
}

/**
 * Check if a date (YYYY-MM-DD) is weekend (Sat/Sun).
 */
function isWeekend(dateStr) {
  const p = parseLocalDate(dateStr);
  if (!p) return false;
  const d = new Date(p.year, p.month, p.day);
  const day = d.getDay();
  return day === 0 || day === 6;
}

/**
 * Add n business days to dateStr (YYYY-MM-DD). Returns YYYY-MM-DD.
 */
export function addBusinessDays(dateStr, n) {
  if (n <= 0) return dateStr;
  let current = dateStr;
  let added = 0;
  while (added < n) {
    const p = parseLocalDate(current);
    if (!p) return null;
    const d = new Date(p.year, p.month, p.day);
    d.setDate(d.getDate() + 1);
    current = formatLocalDate(d);
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
 * Cycle start date: anchor_date + cadence * cycle_index.
 * index 0 = anchor_date, 1 = anchor + 1 cadence, etc.
 */
export function getCycleStartDate(anchorDateStr, cadence, cycleSequence) {
  let current = anchorDateStr;
  for (let i = 0; i < cycleSequence; i++) {
    current = addCadence(current, cadence);
    if (!current) return null;
  }
  return current;
}

/**
 * Cycle end date: cycle start + window business days (last day of window).
 * Exported for ESM import (e.g. cron-generate-subscription-cycles).
 */
export function getCycleEndDate(startDate, frequency) {
  const n = getCycleWindowLength(frequency);
  return addBusinessDays(startDate, n);
}

/**
 * Next cycle sequence = max(cycle_index) + 1, or 1 if none.
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
  return cycle && (cycle.status === "completed" || cycle.status === "missed");
}

/**
 * Whether to apply discount reset: subscription has discount_reset_required and cycle is completing.
 */
export function shouldApplyDiscountReset(subscription) {
  return subscription && subscription.discount_reset_required === true;
}

export { PUSHBACK_BUSINESS_DAYS };
