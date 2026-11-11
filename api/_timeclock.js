// Time clock rules: geofence check, New York pay weeks (Monday–Sunday), hour totals with
// overtime, and flags managers should look at. Pure functions; handlers do the I/O.

import { DateTime } from "luxon";

const BUSINESS_TZ = "America/New_York";
const MAX_ACCURACY_CREDIT_M = 150; // phone GPS error we give the benefit of the doubt for
export const LONG_SHIFT_HOURS = 12;

export function clockSettings() {
  const num = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    radiusM: num("CLOCK_RADIUS_METERS", 400),
    weeklyOvertimeHours: num("OVERTIME_WEEKLY_HOURS", 40),
    overtimeMultiplier: num("OVERTIME_MULTIPLIER", 1.5),
  };
}

export function haversineMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function validPosition(p) {
  return (
    p &&
    Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) &&
    Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180
  );
}

/**
 * Is the phone close enough to one of the sites? sites: [{ label, lat, lng }].
 * Up to 150 m of reported GPS error is credited, so a weak fix at the curb still counts.
 * Returns { ok, nearest: { label, distanceM } | null }.
 */
export function checkGeofence(position, sites, radiusM = clockSettings().radiusM) {
  if (!validPosition(position) || !sites?.length) return { ok: false, nearest: null };
  const here = { lat: Number(position.lat), lng: Number(position.lng) };
  const credit = Math.min(Math.max(Number(position.accuracy) || 0, 0), MAX_ACCURACY_CREDIT_M);
  let nearest = null;
  for (const s of sites) {
    const d = haversineMeters(here, s);
    if (!nearest || d < nearest.distanceM) nearest = { label: s.label, distanceM: Math.round(d) };
  }
  return { ok: nearest.distanceM - credit <= radiusM, nearest };
}

/** Monday–Sunday pay week (New York) containing dateStr. */
export function payWeek(dateStr) {
  const d = DateTime.fromISO(dateStr, { zone: BUSINESS_TZ });
  if (!d.isValid) throw new Error("Invalid date");
  const start = d.startOf("week"); // luxon weeks start Monday
  const end = start.plus({ weeks: 1 });
  return {
    weekStart: start.toISODate(),
    weekEnd: end.minus({ days: 1 }).toISODate(),
    startISO: start.toUTC().toISO(),
    endISO: end.toUTC().toISO(),
  };
}

/** Minutes of an entry that fall inside [startISO, endISO); open entries run until `now`. */
export function minutesWithin(entry, startISO, endISO, now = new Date()) {
  const s = Math.max(Date.parse(entry.clock_in_at), Date.parse(startISO));
  const e = Math.min(entry.clock_out_at ? Date.parse(entry.clock_out_at) : now.getTime(), Date.parse(endISO));
  return Math.max(0, (e - s) / 60000);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Totals for one person's entries in one pay week.
 * Returns { minutes, hours, regularHours, overtimeHours, open, flags[] }.
 */
export function summarizeWeek(entries, week, { now = new Date(), settings = clockSettings() } = {}) {
  const live = entries.filter((e) => !e.voided_at);
  const minutes = live.reduce((sum, e) => sum + minutesWithin(e, week.startISO, week.endISO, now), 0);
  const hours = minutes / 60;
  const regularHours = Math.min(hours, settings.weeklyOvertimeHours);
  const flags = [];
  for (const e of live) {
    const end = e.clock_out_at ? Date.parse(e.clock_out_at) : now.getTime();
    const shiftHours = (end - Date.parse(e.clock_in_at)) / 3600000;
    if (shiftHours > LONG_SHIFT_HOURS) {
      flags.push({
        entry_id: e.id,
        type: e.clock_out_at ? "long_shift" : "forgot_clock_out",
        message: e.clock_out_at
          ? `Shift over ${LONG_SHIFT_HOURS} hours`
          : `Still clocked in after ${Math.floor(shiftHours)} hours — probably forgot to clock out`,
      });
    }
    if (e.verify_method === "pin") {
      flags.push({ entry_id: e.id, type: "pin_clock_in", message: "Clocked in away from the job site (manager PIN)" });
    }
  }
  if (hours > settings.weeklyOvertimeHours) {
    flags.push({ entry_id: null, type: "overtime", message: `${round2(hours - settings.weeklyOvertimeHours)} overtime hours this week` });
  }
  return {
    minutes: Math.round(minutes),
    hours: round2(hours),
    regularHours: round2(regularHours),
    overtimeHours: round2(Math.max(0, hours - settings.weeklyOvertimeHours)),
    open: live.some((e) => !e.clock_out_at),
    flags,
  };
}

/** Fields a manager may change on an entry, validated. Returns { error } or { update }. */
export function parseEntryEdit(body, existing = null) {
  const update = {};
  for (const k of ["clock_in_at", "clock_out_at"]) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === "") {
      if (k === "clock_in_at") return { error: "Clock-in time is required" };
      update[k] = null;
      continue;
    }
    const t = Date.parse(body[k]);
    if (!Number.isFinite(t)) return { error: `Invalid ${k.replace(/_/g, " ")}` };
    update[k] = new Date(t).toISOString();
  }
  if (body.notes !== undefined) update.notes = body.notes ? String(body.notes).slice(0, 500) : null;

  const inAt = update.clock_in_at ?? existing?.clock_in_at;
  const outAt = update.clock_out_at !== undefined ? update.clock_out_at : existing?.clock_out_at;
  if (!inAt) return { error: "Clock-in time is required" };
  if (outAt && Date.parse(outAt) <= Date.parse(inAt)) return { error: "Clock-out must be after clock-in" };
  if (outAt && Date.parse(outAt) - Date.parse(inAt) > 24 * 3600000) return { error: "An entry can't be longer than 24 hours" };
  if (Date.parse(inAt) > Date.now() + 5 * 60000) return { error: "Clock-in can't be in the future" };
  return { update };
}
