import { requireRole, ROLES, serviceClient, sendAuthError, parseBody } from "../_staffAuth.js";
import { completeBooking, parsePayment } from "../_completeBookingCore.js";
import { loadChecklistSteps, stepsForBooking, completionProblems, countPhotos } from "../_jobs.js";

/**
 * POST { booking_id, checklist: {stepId:true}, worked_by: [staffId...],
 *        amount_collected, tip_amount, payment_method, payment_notes }
 * Refuses until every required checklist step is checked and the minimum before/after
 * photos are uploaded, then completes through the same core as the admin page.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const sb = serviceClient();
  let staff;
  try {
    staff = await requireRole(req, ROLES, { sb });
  } catch (err) {
    if (sendAuthError(res, err)) return;
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = parseBody(req);
    const bookingId = body.booking_id;
    if (!bookingId) return res.status(400).json({ error: "Missing booking_id" });

    const { error: paymentError, payment } = parsePayment(body);
    if (paymentError) return res.status(400).json({ error: paymentError });

    const { data: booking, error } = await sb
      .from("bookings")
      .select("id, status, job_flag, service_variants:service_variant_id ( services:service_id ( category, level ) )")
      .eq("id", bookingId)
      .maybeSingle();
    if (error) throw error;
    if (!booking) return res.status(404).json({ error: "Job not found" });
    if (booking.status !== "confirmed") return res.status(409).json({ error: `Job is ${booking.status}` });

    const svc = booking.service_variants?.services || {};
    const steps = stepsForBooking(await loadChecklistSteps(sb), {
      category: svc.category,
      level: svc.level,
      jobFlag: booking.job_flag,
    });
    const checked = {};
    for (const [k, v] of Object.entries(body.checklist || {})) if (v === true) checked[k] = true;

    const { data: photos, error: pErr } = await sb.from("job_photos").select("kind").eq("booking_id", bookingId);
    if (pErr) throw pErr;

    const problems = completionProblems({ steps, checked, photoCounts: countPhotos(photos) });
    if (problems.length) return res.status(422).json({ error: "Job isn't ready to complete", problems });

    // Who worked it: the people picked in the app (active staff only), always including you.
    const requested = Array.isArray(body.worked_by) ? body.worked_by.map(String) : [];
    const { data: activeStaff, error: sErr } = await sb.from("staff").select("id").eq("active", true);
    if (sErr) throw sErr;
    const activeIds = new Set((activeStaff || []).map((s) => s.id));
    const workedBy = [...new Set([staff.id, ...requested])].filter((id) => activeIds.has(id));

    const result = await completeBooking(sb, { bookingId, payment, recordedBy: staff.id, actor: "crew" });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    // Job is completed and paid; these records must not undo it, so failures are logged.
    const now = new Date().toISOString();
    try {
      const { data: existing } = await sb.from("job_completions").select("booking_id").eq("booking_id", bookingId).maybeSingle();
      const record = { checklist: checked, completed_at: now, completed_by: staff.id, updated_at: now };
      if (existing) await sb.from("job_completions").update(record).eq("booking_id", bookingId);
      else await sb.from("job_completions").insert({ booking_id: bookingId, started_at: now, started_by: staff.id, ...record });
      if (workedBy.length) {
        await sb.from("booking_staff").delete().eq("booking_id", bookingId);
        await sb.from("booking_staff").insert(workedBy.map((staff_id) => ({ booking_id: bookingId, staff_id })));
      }
    } catch (recErr) {
      console.error("staff-complete-job: completion record failed", recErr);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("staff-complete-job error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
