// Scheduling rules: what someone's availability is on a date, what's wrong with a shift,
// and which days need coverage. Dates are New York YYYY-MM-DD; times are "HH:MM".
// Pure functions; handlers do the I/O.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:\d\d)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function normTime(t) {
  if (t == null || t === "") return null;
  const m = TIME_RE.exec(String(t));
  return m ? `${m[1]}:${m[2]}` : undefined; // undefined = invalid
}

export function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function weekdayOf(dateStr) {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function datesFrom(start, count) {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

const minutes = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Someone's availability on a date.
 * Precedence: approved time off > one-day exception > weekly rule > nothing set.
 * Returns { status: "available"|"partial"|"unavailable"|"unknown", start, end, note, source,
 *           pendingTimeOff }.
 */
export function availabilityOn(dateStr, { weekly = [], exceptions = [], timeOff = [] } = {}) {
  const covers = (t) => t.start_date <= dateStr && t.end_date >= dateStr;
  const pendingTimeOff = timeOff.some((t) => t.status === "pending" && covers(t));
  const approved = timeOff.find((t) => t.status === "approved" && covers(t));
  if (approved) {
    return { status: "unavailable", start: null, end: null, note: approved.reason || "Time off", source: "time_off", pendingTimeOff };
  }
  const rule =
    exceptions.find((e) => e.on_date === dateStr) ||
    weekly.find((w) => w.weekday === weekdayOf(dateStr));
  if (!rule) return { status: "unknown", start: null, end: null, note: null, source: null, pendingTimeOff };

  const source = rule.on_date ? "exception" : "weekly";
  if (!rule.available) return { status: "unavailable", start: null, end: null, note: rule.note || null, source, pendingTimeOff };
  const start = normTime(rule.start_time) || null;
  const end = normTime(rule.end_time) || null;
  return { status: start || end ? "partial" : "available", start, end, note: rule.note || null, source, pendingTimeOff };
}

/** Problems with putting someone on a shift, given their availability that day. */
export function shiftWarnings(shift, availability) {
  const w = [];
  const s = normTime(shift.start_time);
  const e = normTime(shift.end_time);
  if (availability.status === "unavailable") {
    w.push(availability.source === "time_off" ? "Approved time off this day" : "Marked unavailable this day");
  } else if (availability.status === "partial") {
    if (availability.start && minutes(s) < minutes(availability.start)) w.push(`Available from ${availability.start}`);
    if (availability.end && minutes(e) > minutes(availability.end)) w.push(`Available until ${availability.end}`);
  } else if (availability.status === "unknown") {
    w.push("No availability set for this day");
  }
  if (availability.pendingTimeOff) w.push("Has a pending time-off request");
  if (minutes(e) - minutes(s) > 12 * 60) w.push("Shift is over 12 hours");
  return w;
}

/** Validates shift fields. Returns { error } or { shift }. */
export function parseShift(body, existing = null) {
  const out = {};
  if (body.shift_date !== undefined) {
    if (!isDate(body.shift_date)) return { error: "Invalid date" };
    out.shift_date = body.shift_date;
  }
  for (const k of ["start_time", "end_time"]) {
    if (body[k] === undefined) continue;
    const t = normTime(body[k]);
    if (!t) return { error: `Invalid ${k === "start_time" ? "start" : "end"} time` };
    out[k] = t;
  }
  if (body.notes !== undefined) out.notes = body.notes ? String(body.notes).slice(0, 300) : null;

  const start = out.start_time ?? normTime(existing?.start_time);
  const end = out.end_time ?? normTime(existing?.end_time);
  const date = out.shift_date ?? existing?.shift_date;
  if (!date || !start || !end) return { error: "Date, start and end time are required" };
  if (minutes(end) <= minutes(start)) return { error: "End time must be after start time" };
  return { shift: out };
}

/** Day-level warnings for managers: jobs with nobody scheduled, or crew without a lead. */
export function dayWarnings({ jobs = [], shifts = [] }) {
  const w = [];
  if (jobs.length && !shifts.length) w.push(`${jobs.length} job${jobs.length === 1 ? "" : "s"} but nobody scheduled`);
  if (jobs.length && shifts.length === 1) w.push("Only one person scheduled");
  if (jobs.length && shifts.length) {
    const firstJob = Math.min(...jobs.map((j) => minutes(j.start)));
    const lastJob = Math.max(...jobs.map((j) => minutes(j.end)));
    const covered = shifts.some((s) => minutes(normTime(s.start_time)) <= firstJob);
    const stays = shifts.some((s) => minutes(normTime(s.end_time)) >= lastJob);
    if (!covered) w.push("First job starts before anyone's shift");
    if (!stays) w.push("Last job ends after everyone's shift");
  }
  return w;
}

/** Validates a weekly availability row from the crew app. */
export function parseAvailabilityRow(row) {
  const available = !!row.available;
  const start = normTime(row.start_time);
  const end = normTime(row.end_time);
  if (start === undefined || end === undefined) return { error: "Invalid time" };
  if (available && start && end && minutes(end) <= minutes(start)) return { error: "End time must be after start time" };
  return {
    row: {
      available,
      start_time: available ? start : null,
      end_time: available ? end : null,
      note: row.note ? String(row.note).slice(0, 200) : null,
    },
  };
}
