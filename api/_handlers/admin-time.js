import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient, parseBody } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { isIsoDate } from "../_jobs.js";
import { payWeek, summarizeWeek, parseEntryEdit } from "../_timeclock.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS =
  "id, staff_id, clock_in_at, clock_out_at, verify_method, verified_by, in_site, in_distance_m, in_accuracy_m, out_distance_m, notes, voided_at";

/**
 * Time clock (owner / manager).
 * GET    ?week=YYYY-MM-DD → that Monday–Sunday: per-person entries, totals, overtime and flags,
 *        plus who is on the clock right now.
 * POST   { staff_id, clock_in_at, clock_out_at?, notes?, reason } → add a missed entry
 * PATCH  { id, clock_in_at?, clock_out_at?, notes?, reason } → correct an entry
 * DELETE ?id&reason → void an entry (kept for history)
 * Every change needs a reason and is written to time_entry_edits.
 */
export default async function handler(req, res) {
  let actor;
  try {
    ({ admin: actor } = await verifyAdmin(req));
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const sb = serviceClient();
    const editor = actor.name ? `${actor.name} (${actor.id})` : actor.id;
    const logEdit = (entry_id, action, before, after, reason) =>
      sb.from("time_entry_edits").insert({ entry_id, edited_by: editor, action, before, after, reason });

    if (req.method === "GET") {
      const week = payWeek(isIsoDate(req.query?.week) ? req.query.week : todayNY());
      const [{ data: staff, error: sErr }, { data: entries, error: eErr }, { data: openNow, error: oErr }] = await Promise.all([
        sb.from("staff").select("id, full_name, role, hourly_rate, active").order("full_name"),
        sb
          .from("time_entries")
          .select(COLS)
          .is("voided_at", null)
          .gte("clock_in_at", new Date(Date.parse(week.startISO) - 24 * 3600000).toISOString())
          .lt("clock_in_at", week.endISO)
          .order("clock_in_at"),
        sb.from("time_entries").select("staff_id, clock_in_at, verify_method").is("clock_out_at", null).is("voided_at", null),
      ]);
      for (const e of [sErr, eErr, oErr]) if (e) throw e;

      const names = new Map((staff || []).map((s) => [s.id, s.full_name]));
      const inWeek = (entries || []).filter(
        (e) => !e.clock_out_at || Date.parse(e.clock_out_at) > Date.parse(week.startISO)
      );
      const ids = inWeek.map((e) => e.id);
      let editCounts = new Map();
      if (ids.length) {
        const { data: edits, error: edErr } = await sb.from("time_entry_edits").select("entry_id").in("entry_id", ids);
        if (edErr) throw edErr;
        for (const e of edits || []) editCounts.set(e.entry_id, (editCounts.get(e.entry_id) || 0) + 1);
      }

      const people = (staff || [])
        .map((s) => {
          const mine = inWeek.filter((e) => e.staff_id === s.id);
          if (!s.active && !mine.length) return null;
          return {
            staff: { id: s.id, full_name: s.full_name, role: s.role, hourly_rate: s.hourly_rate },
            summary: summarizeWeek(mine, week),
            entries: mine.map((e) => ({ ...e, verified_by_name: names.get(e.verified_by) || null, edits: editCounts.get(e.id) || 0 })),
          };
        })
        .filter(Boolean);

      return res.status(200).json({
        week: { start: week.weekStart, end: week.weekEnd },
        today: todayNY(),
        on_clock: (openNow || []).map((o) => ({ ...o, full_name: names.get(o.staff_id) || "Unknown" })),
        people,
      });
    }

    const body = req.method === "DELETE" ? { ...req.query } : parseBody(req);
    const reason = String(body.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "Please give a reason for the change" });

    if (req.method === "POST") {
      if (!body.staff_id) return res.status(400).json({ error: "Missing staff_id" });
      const { error, update } = parseEntryEdit(body);
      if (error) return res.status(400).json({ error });
      const row = {
        staff_id: body.staff_id,
        ...update,
        verify_method: "manager",
        verified_by: UUID_RE.test(actor.id) ? actor.id : null,
      };
      const { data, error: insErr } = await sb.from("time_entries").insert(row).select(COLS).single();
      if (insErr) {
        if (insErr.code === "23505") return res.status(409).json({ error: "This person already has an open entry; close it first" });
        throw insErr;
      }
      await logEdit(data.id, "create", null, data, reason);
      return res.status(201).json({ entry: data });
    }

    if (!body.id) return res.status(400).json({ error: "Missing id" });
    const { data: existing, error: exErr } = await sb.from("time_entries").select(COLS).eq("id", body.id).maybeSingle();
    if (exErr) throw exErr;
    if (!existing || existing.voided_at) return res.status(404).json({ error: "Entry not found" });

    if (req.method === "PATCH") {
      const { error, update } = parseEntryEdit(body, existing);
      if (error) return res.status(400).json({ error });
      update.updated_at = new Date().toISOString();
      const { data, error: upErr } = await sb.from("time_entries").update(update).eq("id", existing.id).select(COLS).single();
      if (upErr) {
        if (upErr.code === "23505") return res.status(409).json({ error: "This person already has an open entry" });
        throw upErr;
      }
      await logEdit(existing.id, "update", existing, data, reason);
      return res.status(200).json({ entry: data });
    }

    if (req.method === "DELETE") {
      const now = new Date().toISOString();
      const { data, error: vErr } = await sb
        .from("time_entries")
        .update({ voided_at: now, updated_at: now })
        .eq("id", existing.id)
        .select(COLS)
        .single();
      if (vErr) throw vErr;
      await logEdit(existing.id, "void", existing, data, reason);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin-time error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
