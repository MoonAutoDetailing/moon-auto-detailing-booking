import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient, parseBody } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { isIsoDate } from "../_jobs.js";
import { payWeek } from "../_timeclock.js";
import { availabilityOn, shiftWarnings, parseShift, dayWarnings, datesFrom, addDays, planAutoFill } from "../_schedule.js";
import { sendWeekEmail } from "../../lib/email/crewEmails.js";

const SHIFT_COLS = "id, staff_id, shift_date, start_time, end_time, notes, published, published_at";
const nyTime = (iso) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
const nyDate = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const hhmm = (t) => (t ? String(t).slice(0, 5) : t);

/** Everything the schedule needs for one pay week. */
async function loadWeek(sb, week) {
  const [
    { data: staff, error: sErr },
    { data: shifts, error: shErr },
    { data: avail, error: aErr },
    { data: off, error: oErr },
    { data: jobs, error: jErr },
  ] = await Promise.all([
    sb.from("staff").select("id, full_name, role, active").eq("active", true).order("full_name"),
    sb.from("shifts").select(SHIFT_COLS).gte("shift_date", week.weekStart).lte("shift_date", week.weekEnd).order("start_time"),
    sb.from("staff_availability").select("staff_id, weekday, on_date, available, start_time, end_time, note"),
    sb.from("time_off_requests").select("id, staff_id, start_date, end_date, reason, status, created_at").in("status", ["pending", "approved"]).gte("end_date", addDays(week.weekStart, -60)),
    sb
      .from("bookings")
      .select("id, scheduled_start, scheduled_end, status, job_flag, customers:customer_id ( full_name ), service_variants:service_variant_id ( services:service_id ( category, level ) )")
      .in("status", ["pending", "confirmed", "completed"])
      .gte("scheduled_start", week.startISO)
      .lt("scheduled_start", week.endISO)
      .order("scheduled_start"),
  ]);
  for (const e of [sErr, shErr, aErr, oErr, jErr]) if (e) throw e;

  const availFor = (staffId, date) =>
    availabilityOn(date, {
      weekly: (avail || []).filter((a) => a.staff_id === staffId && a.weekday != null),
      exceptions: (avail || []).filter((a) => a.staff_id === staffId && a.on_date),
      timeOff: (off || []).filter((t) => t.staff_id === staffId),
    });
  const jobsOn = (date) =>
    (jobs || [])
      .filter((j) => nyDate(j.scheduled_start) === date && j.status !== "pending")
      .map((j) => ({
        id: j.id,
        start: nyTime(j.scheduled_start),
        end: nyTime(j.scheduled_end),
        customer: j.customers?.full_name || "Customer",
        service: j.service_variants?.services ? `${j.service_variants.services.category} L${j.service_variants.services.level}` : "Service",
        ceramic: j.job_flag === "ceramic",
        status: j.status,
      }));
  return { staff: staff || [], shifts: shifts || [], off: off || [], jobs: jobs || [], availFor, jobsOn };
}

/**
 * Manager scheduling.
 * GET ?week=YYYY-MM-DD → Monday–Sunday: jobs per day, shifts, each person's availability,
 *     warnings, and pending time-off requests.
 * POST { action: "shift", staff_id, shift_date, start_time, end_time, notes? } → draft shift
 * POST { action: "copy_week", from_week, to_week } → copies a week's shifts as drafts
 * POST { action: "auto_fill", week } → drafts a shift covering each day's jobs for every
 *      employee who is available and not already scheduled that day
 * POST { action: "publish", week } → publishes the week's drafts and emails each person their shifts
 * POST { action: "time_off", id, status: "approved"|"denied", note? }
 * PATCH { id, shift_date?, start_time?, end_time?, notes?, staff_id? } → edits go back to draft
 * DELETE ?id → removes a shift
 */
export default async function handler(req, res) {
  let actor;
  try {
    ({ admin: actor } = await verifyAdmin(req));
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const editor = actor.name ? `${actor.name} (${actor.id})` : actor.id;

  try {
    const sb = serviceClient();

    if (req.method === "GET") {
      const week = payWeek(isIsoDate(req.query?.week) ? req.query.week : todayNY());
      const days = datesFrom(week.weekStart, 7);
      const { staff, shifts, off, jobs, availFor, jobsOn } = await loadWeek(sb, week);

      const people = (staff || []).filter((s) => s.role !== "owner" || (shifts || []).some((x) => x.staff_id === s.id));
      const names = new Map((staff || []).map((s) => [s.id, s.full_name]));

      const dayData = days.map((date) => {
        const dayJobs = jobsOn(date);
        const pending = (jobs || []).filter((j) => nyDate(j.scheduled_start) === date && j.status === "pending").length;
        const dayShifts = (shifts || [])
          .filter((s) => s.shift_date === date)
          .map((s) => {
            const a = availFor(s.staff_id, date);
            return { ...s, start_time: hhmm(s.start_time), end_time: hhmm(s.end_time), full_name: names.get(s.staff_id) || "Former staff", warnings: shiftWarnings(s, a) };
          });
        return {
          date,
          jobs: dayJobs,
          pending_requests: pending,
          shifts: dayShifts,
          availability: Object.fromEntries(people.map((p) => [p.id, availFor(p.id, date)])),
          warnings: dayWarnings({ jobs: dayJobs, shifts: dayShifts }),
        };
      });

      return res.status(200).json({
        week: { start: week.weekStart, end: week.weekEnd },
        today: todayNY(),
        people: people.map((p) => ({ id: p.id, full_name: p.full_name, role: p.role })),
        days: dayData,
        drafts: (shifts || []).filter((s) => !s.published).length,
        time_off: (off || [])
          .filter((t) => t.status === "pending")
          .map((t) => ({ ...t, full_name: names.get(t.staff_id) || "Unknown" })),
      });
    }

    const body = req.method === "DELETE" ? { ...req.query } : parseBody(req);

    if (req.method === "POST" && body.action === "shift") {
      if (!body.staff_id) return res.status(400).json({ error: "Pick a team member" });
      const { error, shift } = parseShift(body);
      if (error) return res.status(400).json({ error });
      const { data, error: insErr } = await sb
        .from("shifts")
        .insert({ staff_id: body.staff_id, ...shift, created_by: editor })
        .select(SHIFT_COLS)
        .single();
      if (insErr) throw insErr;
      return res.status(201).json({ shift: data });
    }

    if (req.method === "POST" && body.action === "copy_week") {
      if (!isIsoDate(body.from_week) || !isIsoDate(body.to_week)) return res.status(400).json({ error: "Invalid weeks" });
      const from = payWeek(body.from_week);
      const to = payWeek(body.to_week);
      if (from.weekStart === to.weekStart) return res.status(400).json({ error: "Pick a different week to copy from" });
      const [{ data: src, error: e1 }, { data: existing, error: e2 }] = await Promise.all([
        sb.from("shifts").select(SHIFT_COLS).gte("shift_date", from.weekStart).lte("shift_date", from.weekEnd),
        sb.from("shifts").select(SHIFT_COLS).gte("shift_date", to.weekStart).lte("shift_date", to.weekEnd),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const offset = Math.round((Date.parse(to.weekStart) - Date.parse(from.weekStart)) / 86400000);
      const key = (s) => `${s.staff_id}|${s.shift_date}|${hhmm(s.start_time)}|${hhmm(s.end_time)}`;
      const have = new Set((existing || []).map(key));
      const rows = (src || [])
        .map((s) => ({ staff_id: s.staff_id, shift_date: addDays(s.shift_date, offset), start_time: hhmm(s.start_time), end_time: hhmm(s.end_time), notes: s.notes, created_by: editor }))
        .filter((s) => !have.has(key(s)));
      if (rows.length) {
        const { error: insErr } = await sb.from("shifts").insert(rows);
        if (insErr) throw insErr;
      }
      return res.status(200).json({ copied: rows.length, skipped: (src || []).length - rows.length });
    }

    if (req.method === "POST" && body.action === "auto_fill") {
      if (!isIsoDate(body.week)) return res.status(400).json({ error: "Invalid week" });
      const week = payWeek(body.week);
      const { staff, shifts, availFor, jobsOn } = await loadWeek(sb, week);
      const people = staff.filter((p) => p.role === "employee");
      if (!people.length) return res.status(400).json({ error: "Add employees under Team first" });
      const plan = planAutoFill({
        days: datesFrom(week.weekStart, 7).map((date) => ({ date, jobs: jobsOn(date) })),
        people,
        availabilityFor: availFor,
        existing: shifts,
      });
      if (plan.shifts.length) {
        const { error: insErr } = await sb.from("shifts").insert(plan.shifts.map((x) => ({ ...x, created_by: editor })));
        if (insErr) throw insErr;
      }
      const names = new Map(staff.map((p) => [p.id, p.full_name]));
      return res.status(200).json({
        created: plan.shifts.length,
        skipped: plan.skipped.map((k) => ({ ...k, full_name: names.get(k.staff_id) || "Unknown" })),
      });
    }

    if (req.method === "POST" && body.action === "publish") {
      if (!isIsoDate(body.week)) return res.status(400).json({ error: "Invalid week" });
      const week = payWeek(body.week);
      const now = new Date().toISOString();
      const { data: published, error: pubErr } = await sb
        .from("shifts")
        .update({ published: true, published_at: now, updated_at: now })
        .eq("published", false)
        .gte("shift_date", week.weekStart)
        .lte("shift_date", week.weekEnd)
        .select("staff_id");
      if (pubErr) throw pubErr;

      // Email everyone whose shifts changed their full week (published shifts, in order).
      const affected = [...new Set((published || []).map((s) => s.staff_id))];
      const results = { published: (published || []).length, emailed: 0, email_failed: [] };
      if (affected.length) {
        const [{ data: people, error: ppErr }, { data: weekShifts, error: wsErr }] = await Promise.all([
          sb.from("staff").select("id, full_name, email, active").in("id", affected),
          sb.from("shifts").select(SHIFT_COLS).eq("published", true).in("staff_id", affected).gte("shift_date", week.weekStart).lte("shift_date", week.weekEnd).order("shift_date").order("start_time"),
        ]);
        if (ppErr) throw ppErr;
        if (wsErr) throw wsErr;
        for (const p of people || []) {
          if (!p.active) continue;
          const mine = (weekShifts || []).filter((s) => s.staff_id === p.id);
          const r = await sendWeekEmail(p, mine);
          if (r.success) results.emailed++;
          else results.email_failed.push(p.full_name);
        }
      }
      return res.status(200).json(results);
    }

    if (req.method === "POST" && body.action === "time_off") {
      if (!body.id || !["approved", "denied"].includes(body.status)) return res.status(400).json({ error: "Invalid request" });
      const { data, error } = await sb
        .from("time_off_requests")
        .update({ status: body.status, reviewed_by: editor, reviewed_at: new Date().toISOString(), review_note: body.note ? String(body.note).slice(0, 300) : null })
        .eq("id", body.id)
        .eq("status", "pending")
        .select("id, status")
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(409).json({ error: "Request was already handled" });
      return res.status(200).json({ time_off: data });
    }

    if (req.method === "PATCH") {
      if (!body.id) return res.status(400).json({ error: "Missing id" });
      const { data: existing, error: exErr } = await sb.from("shifts").select(SHIFT_COLS).eq("id", body.id).maybeSingle();
      if (exErr) throw exErr;
      if (!existing) return res.status(404).json({ error: "Shift not found" });
      const { error, shift } = parseShift(body, existing);
      if (error) return res.status(400).json({ error });
      if (body.staff_id) shift.staff_id = body.staff_id;
      // A changed shift goes back to draft so the person is told when it's re-published.
      const { data, error: upErr } = await sb
        .from("shifts")
        .update({ ...shift, published: false, published_at: null, morning_email_sent_at: null, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select(SHIFT_COLS)
        .single();
      if (upErr) throw upErr;
      return res.status(200).json({ shift: data });
    }

    if (req.method === "DELETE") {
      if (!body.id) return res.status(400).json({ error: "Missing id" });
      const { error } = await sb.from("shifts").delete().eq("id", body.id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("admin-schedule error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
