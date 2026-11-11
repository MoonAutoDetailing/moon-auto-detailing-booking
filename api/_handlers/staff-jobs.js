import { requireRole, ROLES, serviceClient, sendAuthError } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { JOB_SELECT, crewJobView, nyDayRange, isIsoDate, countPhotos } from "../_jobs.js";

/**
 * GET ?date=YYYY-MM-DD (New York; default today) → that day's confirmed/completed jobs.
 * GET ?upcoming=14 → the next N days (max 31) starting today, for the schedule tab.
 * The whole crew sees every job (one-crew model).
 */
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const sb = serviceClient();
  try {
    await requireRole(req, ROLES, { sb });
  } catch (err) {
    if (sendAuthError(res, err)) return;
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const today = todayNY();
    const upcoming = Math.min(Math.max(parseInt(req.query?.upcoming, 10) || 0, 0), 31);
    const date = upcoming ? today : (isIsoDate(req.query?.date) ? req.query.date : today);
    const { startISO, endISO } = nyDayRange(date, upcoming || 1);

    const { data, error } = await sb
      .from("bookings")
      .select(JOB_SELECT)
      .in("status", ["confirmed", "completed"])
      .gte("scheduled_start", startISO)
      .lt("scheduled_start", endISO)
      .order("scheduled_start", { ascending: true });
    if (error) throw error;

    const ids = (data || []).map((b) => b.id);
    let photosByJob = new Map();
    let workByJob = new Map();
    if (ids.length) {
      const [{ data: photos, error: pErr }, { data: work, error: wErr }] = await Promise.all([
        sb.from("job_photos").select("booking_id, kind").in("booking_id", ids),
        sb.from("job_completions").select("booking_id, started_at, completed_at").in("booking_id", ids),
      ]);
      if (pErr) throw pErr;
      if (wErr) throw wErr;
      for (const p of photos || []) {
        if (!photosByJob.has(p.booking_id)) photosByJob.set(p.booking_id, []);
        photosByJob.get(p.booking_id).push(p);
      }
      workByJob = new Map((work || []).map((w) => [w.booking_id, w]));
    }

    const jobs = (data || []).map((b) =>
      crewJobView(b, {
        photo_counts: countPhotos(photosByJob.get(b.id)),
        started_at: workByJob.get(b.id)?.started_at || null,
      })
    );
    return res.status(200).json({ date, today, jobs, ceramic_today: jobs.some((j) => j.job_flag === "ceramic") });
  } catch (err) {
    console.error("staff-jobs error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
