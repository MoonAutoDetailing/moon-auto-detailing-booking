// Keeps booking availability in step with who on the team can work each day.
//
//   2+ people available → normal booking (any automatic solo/closed setting is removed)
//   1 person available  → Solo Mode for the day (staffing_overrides, source 'auto')
//   nobody available    → the day is closed to new bookings (availability_overrides, 'auto')
//
// "Available" uses the same rule as the crew schedule (approved time off > one-day change >
// usual week). Someone who hasn't set a day counts as available. Employees and managers always
// count; the owner only once they've set a usual week (so an owner who isn't on the tools never
// changes booking). Anything set by hand on the Availability screen ('manual') always wins.
// It never touches existing bookings and never calls the availability engine.

import { availabilityOn, addDays, datesFrom, weekdayOf } from "./_schedule.js";
import { nyDayRange } from "./_jobs.js";

// Mirrors BUSINESS_RULES.allowedWeekdays in get-availability.js (Mon–Fri).
export const OPEN_WEEKDAYS = [1, 2, 3, 4, 5];
export const SYNC_DAYS = 60;

const nyDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** People whose availability decides booking capacity. */
export function crewForCoverage(staff, avail) {
  const hasWeek = new Set(avail.filter((a) => a.weekday != null).map((a) => a.staff_id));
  return staff.filter((s) => s.active && (s.role === "employee" || s.role === "manager" || (s.role === "owner" && hasWeek.has(s.id))));
}

/** { date: { available: [names], off: [names] } } for each date. */
export function coverageByDate(dates, { crew, avail, timeOff }) {
  const out = {};
  for (const date of dates) {
    const available = [];
    const off = [];
    for (const p of crew) {
      const a = availabilityOn(date, {
        weekly: avail.filter((x) => x.staff_id === p.id && x.weekday != null),
        exceptions: avail.filter((x) => x.staff_id === p.id && x.on_date),
        timeOff: timeOff.filter((t) => t.staff_id === p.id),
      });
      (a.status === "unavailable" ? off : available).push(p.full_name);
    }
    out[date] = { available, off };
  }
  return out;
}

/**
 * What to change so booking matches coverage. Pure.
 * staffing / blocks: existing rows by date ({ source, mode, scope }).
 */
export function planSync(dates, coverage, { staffing = {}, blocks = {} } = {}) {
  const plan = { addSolo: [], removeSolo: [], addBlock: [], removeBlock: [] };
  for (const date of dates) {
    if (!OPEN_WEEKDAYS.includes(weekdayOf(date))) continue;
    const n = coverage[date]?.available.length ?? 0;
    const solo = staffing[date];
    const block = blocks[date];
    const wantSolo = n === 1;
    const wantBlock = n === 0;

    if (wantBlock && !block) plan.addBlock.push(date);
    if (!wantBlock && block?.source === "auto") plan.removeBlock.push(date);
    if (wantSolo && !solo) plan.addSolo.push(date);
    if (!wantSolo && solo?.source === "auto") plan.removeSolo.push(date);
  }
  return plan;
}

async function loadTeam(sb, from, to) {
  const [{ data: staff, error: sErr }, { data: avail, error: aErr }, { data: timeOff, error: tErr }] = await Promise.all([
    sb.from("staff").select("id, full_name, role, active"),
    sb.from("staff_availability").select("staff_id, weekday, on_date, available, start_time, end_time, note"),
    sb.from("time_off_requests").select("staff_id, start_date, end_date, reason, status").in("status", ["approved", "pending"]).lte("start_date", to).gte("end_date", from),
  ]);
  for (const e of [sErr, aErr, tErr]) if (e) throw e;
  return { staff: staff || [], avail: avail || [], timeOff: timeOff || [] };
}

/**
 * Applies planSync() for the next SYNC_DAYS days. Safe to call after any availability or
 * time-off change; returns what changed. Does nothing when no one is set up on the team.
 */
export async function syncBookingAvailability(sb, { from, days = SYNC_DAYS } = {}) {
  const dates = datesFrom(from, days);
  const to = dates[dates.length - 1];
  const { staff, avail, timeOff } = await loadTeam(sb, from, to);
  const crew = crewForCoverage(staff, avail);
  if (!crew.length) return { skipped: "no team members", addSolo: [], removeSolo: [], addBlock: [], removeBlock: [] };

  const coverage = coverageByDate(dates, { crew, avail, timeOff: timeOff.filter((t) => t.status === "approved") });
  const [{ data: soloRows, error: soErr }, { data: blockRows, error: bErr }] = await Promise.all([
    sb.from("staffing_overrides").select("override_date, solo_mode, source").gte("override_date", from).lte("override_date", to),
    sb.from("availability_overrides").select("override_date, mode, scope, source").gte("override_date", from).lte("override_date", to),
  ]);
  if (soErr) throw soErr;
  if (bErr) throw bErr;
  const plan = planSync(dates, coverage, {
    staffing: Object.fromEntries((soloRows || []).filter((r) => r.solo_mode).map((r) => [r.override_date, r])),
    blocks: Object.fromEntries((blockRows || []).map((r) => [r.override_date, r])),
  });

  const now = new Date().toISOString();
  if (plan.addSolo.length) {
    const { error } = await sb.from("staffing_overrides").insert(plan.addSolo.map((d) => ({ override_date: d, solo_mode: true, source: "auto", updated_at: now })));
    if (error) throw error;
  }
  if (plan.removeSolo.length) {
    const { error } = await sb.from("staffing_overrides").delete().in("override_date", plan.removeSolo).eq("source", "auto");
    if (error) throw error;
  }
  if (plan.addBlock.length) {
    const { error } = await sb.from("availability_overrides").insert(
      plan.addBlock.map((d) => ({ override_date: d, mode: "blocked", scope: "full_day", reason: "Auto: nobody on the team is available", source: "auto", updated_at: now }))
    );
    if (error) throw error;
  }
  if (plan.removeBlock.length) {
    const { error } = await sb.from("availability_overrides").delete().in("override_date", plan.removeBlock).eq("source", "auto");
    if (error) throw error;
  }
  return plan;
}

/** Runs the sync and logs instead of failing the action that triggered it. */
export async function syncSafely(sb, from) {
  try {
    return await syncBookingAvailability(sb, { from });
  } catch (err) {
    console.error("team coverage sync failed", err);
    return null;
  }
}

/**
 * What a time-off request (or a "can't work" day) would leave: for each open day in the range,
 * how many others are still available and how many jobs are booked. Only days worth a warning
 * (fewer than 2 others, or jobs with nobody left) are returned.
 */
export async function timeOffImpact(sb, { staffId, start, end }) {
  const days = [];
  for (let d = start; d <= end && days.length < 62; d = addDays(d, 1)) days.push(d);
  if (!days.length) return [];
  const { staff, avail, timeOff } = await loadTeam(sb, start, end);
  const crew = crewForCoverage(staff, avail).filter((p) => p.id !== staffId);
  const coverage = coverageByDate(days, { crew, avail, timeOff: timeOff.filter((t) => t.status === "approved") });
  const { data: jobs, error } = await sb
    .from("bookings")
    .select("scheduled_start")
    .in("status", ["pending", "confirmed"])
    .gte("scheduled_start", nyDayRange(start).startISO)
    .lt("scheduled_start", nyDayRange(end).endISO);
  if (error) throw error;
  const jobsOn = {};
  for (const j of jobs || []) jobsOn[nyDate(j.scheduled_start)] = (jobsOn[nyDate(j.scheduled_start)] || 0) + 1;

  return days
    .map((date) => ({ date, others: coverage[date].available.length, others_names: coverage[date].available, jobs: jobsOn[date] || 0 }))
    .filter((x) => OPEN_WEEKDAYS.includes(weekdayOf(x.date)) && (x.others < 2 || (x.jobs && x.others === 0)));
}

/** Plain-English warning for a list from timeOffImpact(); "" when there's nothing to say. */
export function impactWarning(impact, { names = false } = {}) {
  if (!impact?.length) return "";
  const day = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  return impact
    .map((x) => {
      const jobs = x.jobs ? ` · ${x.jobs} job${x.jobs === 1 ? "" : "s"} booked` : "";
      if (x.others === 0) return `${day(x.date)}: nobody else is available — booking closes that day${jobs}`;
      const who = names && x.others_names?.length ? x.others_names[0] : "one other person";
      return `${day(x.date)}: only ${who} would be working (solo mode)${jobs}`;
    })
    .join("\n");
}
