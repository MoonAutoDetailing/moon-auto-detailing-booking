import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient, parseBody } from "../_staffAuth.js";
import { loadChecklistSteps, stepsForBooking, withSignedUrls } from "../_jobs.js";

/**
 * GET ?booking_id → QC review: photos (signed URLs), checklist with what was ticked, who
 *                   started/completed it and who worked it.
 * PATCH { booking_id, job_flag?: "ceramic"|null, crew_notes?: string|null }
 */
export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const sb = serviceClient();

    if (req.method === "PATCH") {
      const body = parseBody(req);
      if (!body.booking_id) return res.status(400).json({ error: "Missing booking_id" });
      const update = {};
      if (body.job_flag !== undefined) {
        if (body.job_flag !== null && body.job_flag !== "ceramic") return res.status(400).json({ error: "Invalid job_flag" });
        update.job_flag = body.job_flag;
      }
      if (body.crew_notes !== undefined) {
        const notes = body.crew_notes == null ? "" : String(body.crew_notes).trim();
        update.crew_notes = notes ? notes.slice(0, 2000) : null;
      }
      if (!Object.keys(update).length) return res.status(400).json({ error: "Nothing to update" });
      const { data, error } = await sb
        .from("bookings")
        .update(update)
        .eq("id", body.booking_id)
        .select("id, job_flag, crew_notes")
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "Booking not found" });
      return res.status(200).json({ booking: data });
    }

    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const bookingId = req.query?.booking_id;
    if (!bookingId) return res.status(400).json({ error: "Missing booking_id" });

    const { data: booking, error } = await sb
      .from("bookings")
      .select("id, status, job_flag, crew_notes, service_variants:service_variant_id ( services:service_id ( category, level ) )")
      .eq("id", bookingId)
      .maybeSingle();
    if (error) throw error;
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const [steps, { data: work, error: wErr }, { data: photos, error: pErr }, { data: worked, error: bErr }, { data: staff, error: sErr }] =
      await Promise.all([
        loadChecklistSteps(sb),
        sb.from("job_completions").select("*").eq("booking_id", bookingId).maybeSingle(),
        sb.from("job_photos").select("id, kind, storage_path, staff_id, caption, taken_at").eq("booking_id", bookingId).order("taken_at"),
        sb.from("booking_staff").select("staff_id").eq("booking_id", bookingId),
        sb.from("staff").select("id, full_name"),
      ]);
    for (const e of [wErr, pErr, bErr, sErr]) if (e) throw e;

    const names = new Map((staff || []).map((s) => [s.id, s.full_name]));
    const svc = booking.service_variants?.services || {};
    const checked = work?.checklist || {};
    const checklist = stepsForBooking(steps, { category: svc.category, level: svc.level, jobFlag: booking.job_flag })
      .map((s) => ({ id: s.id, scope: s.scope, text: s.text, required: s.required, done: !!checked[s.id] }));
    const signed = await withSignedUrls(sb, photos || []);

    return res.status(200).json({
      booking: { id: booking.id, status: booking.status, job_flag: booking.job_flag, crew_notes: booking.crew_notes },
      started_at: work?.started_at || null,
      started_by: names.get(work?.started_by) || null,
      completed_at: work?.completed_at || null,
      completed_by: names.get(work?.completed_by) || null,
      worked_by: (worked || []).map((w) => names.get(w.staff_id) || "Unknown"),
      checklist,
      photos: signed.map(({ storage_path, staff_id, ...p }) => ({ ...p, taken_by: names.get(staff_id) || null })),
    });
  } catch (err) {
    console.error("admin-job error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
