import { requireRole, ROLES, serviceClient, sendAuthError, parseBody } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { isDate, addDays, parseAvailabilityRow } from "../_schedule.js";
import { syncSafely, timeOffImpact, impactWarning } from "../_teamCoverage.js";

const AVAIL_COLS = "id, weekday, on_date, available, start_time, end_time, note";
const OFF_COLS = "id, start_date, end_date, reason, status, review_note, created_at";

/**
 * A team member's own availability.
 * GET → { weekly: [7 rows, Sunday first], exceptions, time_off }
 * PUT { weekly: [{ weekday, available, start_time, end_time, note }] } → replaces the weekly pattern
 * POST { kind: "exception", on_date, available, start_time?, end_time?, note? } → one-day change
 * POST { kind: "time_off", start_date, end_date, reason? } → request time off (manager approves)
 * DELETE ?exception_id= | ?time_off_id= → remove an exception / cancel a pending request
 */
export default async function handler(req, res) {
  const sb = serviceClient();
  let staff;
  try {
    staff = await requireRole(req, ROLES, { sb });
  } catch (err) {
    if (sendAuthError(res, err)) return;
    return res.status(401).json({ error: "Unauthorized" });
  }

  const load = async () => {
    const today = todayNY();
    const [{ data: avail, error: aErr }, { data: off, error: oErr }] = await Promise.all([
      sb.from("staff_availability").select(AVAIL_COLS).eq("staff_id", staff.id),
      sb.from("time_off_requests").select(OFF_COLS).eq("staff_id", staff.id).gte("end_date", addDays(today, -30)).order("start_date"),
    ]);
    if (aErr) throw aErr;
    if (oErr) throw oErr;
    const weekly = Array.from({ length: 7 }, (_, weekday) => {
      const r = (avail || []).find((a) => a.weekday === weekday);
      return r
        ? { weekday, available: r.available, start_time: r.start_time?.slice(0, 5) || null, end_time: r.end_time?.slice(0, 5) || null, note: r.note, set: true }
        : { weekday, available: null, start_time: null, end_time: null, note: null, set: false };
    });
    const exceptions = (avail || [])
      .filter((a) => a.on_date && a.on_date >= today)
      .sort((a, b) => (a.on_date < b.on_date ? -1 : 1))
      .map((a) => ({ ...a, start_time: a.start_time?.slice(0, 5) || null, end_time: a.end_time?.slice(0, 5) || null }));
    return { weekly, exceptions, time_off: (off || []).filter((t) => t.status !== "cancelled"), today };
  };

  // Changes to when someone can work feed booking availability (solo / closed days).
  const loadAndSync = async () => {
    await syncSafely(sb, todayNY());
    return load();
  };

  try {
    if (req.method === "GET") {
      // ?impact_start&impact_end: what taking those days off would leave, shown before asking.
      const { impact_start: start, impact_end: end } = req.query || {};
      if (isDate(start) && isDate(end) && end >= start) {
        const impact = await timeOffImpact(sb, { staffId: staff.id, start, end });
        return res.status(200).json({ impact, warning: impactWarning(impact) });
      }
      return res.status(200).json(await load());
    }

    if (req.method === "PUT") {
      const body = parseBody(req);
      if (!Array.isArray(body.weekly)) return res.status(400).json({ error: "Missing weekly" });
      const rows = [];
      for (const r of body.weekly) {
        const weekday = Number(r.weekday);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: "Invalid weekday" });
        if (r.available === null || r.available === undefined) continue; // left blank = not set
        const { error, row } = parseAvailabilityRow(r);
        if (error) return res.status(400).json({ error });
        rows.push({ staff_id: staff.id, weekday, ...row });
      }
      const { error: delErr } = await sb.from("staff_availability").delete().eq("staff_id", staff.id).not("weekday", "is", null);
      if (delErr) throw delErr;
      if (rows.length) {
        const { error: insErr } = await sb.from("staff_availability").insert(rows);
        if (insErr) throw insErr;
      }
      return res.status(200).json(await loadAndSync());
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const today = todayNY();

      if (body.kind === "exception") {
        if (!isDate(body.on_date) || body.on_date < today) return res.status(400).json({ error: "Pick today or a future date" });
        const { error, row } = parseAvailabilityRow(body);
        if (error) return res.status(400).json({ error });
        const { error: delErr } = await sb.from("staff_availability").delete().eq("staff_id", staff.id).eq("on_date", body.on_date);
        if (delErr) throw delErr;
        const { error: insErr } = await sb.from("staff_availability").insert({ staff_id: staff.id, on_date: body.on_date, ...row });
        if (insErr) throw insErr;
        return res.status(200).json(await loadAndSync());
      }

      if (body.kind === "time_off") {
        if (!isDate(body.start_date) || !isDate(body.end_date)) return res.status(400).json({ error: "Pick start and end dates" });
        if (body.start_date < today) return res.status(400).json({ error: "Time off can't start in the past" });
        if (body.end_date < body.start_date) return res.status(400).json({ error: "End date must be on or after the start date" });
        const { error: insErr } = await sb.from("time_off_requests").insert({
          staff_id: staff.id,
          start_date: body.start_date,
          end_date: body.end_date,
          reason: body.reason ? String(body.reason).slice(0, 300) : null,
        });
        if (insErr) throw insErr;
        return res.status(200).json(await load());
      }

      return res.status(400).json({ error: "Unknown kind" });
    }

    if (req.method === "DELETE") {
      if (req.query?.exception_id) {
        const { error } = await sb
          .from("staff_availability")
          .delete()
          .eq("id", req.query.exception_id)
          .eq("staff_id", staff.id)
          .not("on_date", "is", null);
        if (error) throw error;
        return res.status(200).json(await loadAndSync());
      }
      if (req.query?.time_off_id) {
        const { data, error } = await sb
          .from("time_off_requests")
          .update({ status: "cancelled" })
          .eq("id", req.query.time_off_id)
          .eq("staff_id", staff.id)
          .eq("status", "pending")
          .select("id");
        if (error) throw error;
        if (!data?.length) return res.status(409).json({ error: "Only pending requests can be cancelled" });
        return res.status(200).json(await load());
      }
      return res.status(400).json({ error: "Missing id" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("staff-availability error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
