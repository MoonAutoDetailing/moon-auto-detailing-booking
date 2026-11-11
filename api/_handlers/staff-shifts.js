import { requireRole, ROLES, serviceClient, sendAuthError } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { addDays } from "../_schedule.js";

/**
 * GET ?days=14 → published shifts from today for the whole crew (one-crew model), with
 * names and which ones are yours. Unpublished drafts are never shown to the crew.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const sb = serviceClient();
  let staff;
  try {
    staff = await requireRole(req, ROLES, { sb });
  } catch (err) {
    if (sendAuthError(res, err)) return;
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const today = todayNY();
    const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 14, 1), 31);
    const { data, error } = await sb
      .from("shifts")
      .select("id, staff_id, shift_date, start_time, end_time, notes, staff:staff_id ( full_name )")
      .eq("published", true)
      .gte("shift_date", today)
      .lte("shift_date", addDays(today, days - 1))
      .order("shift_date")
      .order("start_time");
    if (error) throw error;
    const shifts = (data || []).map((s) => ({
      id: s.id,
      shift_date: s.shift_date,
      start_time: s.start_time?.slice(0, 5),
      end_time: s.end_time?.slice(0, 5),
      notes: s.notes,
      full_name: s.staff?.full_name || "Crew",
      mine: s.staff_id === staff.id,
    }));
    return res.status(200).json({ today, shifts });
  } catch (err) {
    console.error("staff-shifts error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
