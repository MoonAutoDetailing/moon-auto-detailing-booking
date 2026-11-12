import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "../_verifyAdmin.js";
import { completeBooking, parsePayment } from "../_completeBookingCore.js";

// Admin/manager completion. Photos and checklist are not required here (an owner may close
// out a job remotely); the crew app uses staff-complete-job, which enforces them.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const bookingId = body.booking_id || body.bookingId;

  if (!bookingId) {
    return res.status(400).json({ error: "Missing booking_id" });
  }

  const { error: paymentError, payment } = parsePayment(body);
  if (paymentError) return res.status(400).json({ error: paymentError });

  try {
    let adminSession = null;
    try {
      adminSession = await verifyAdmin(req);
    } catch (err) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Who worked it (active staff only), so tips recorded here reach payroll.
    const requested = Array.isArray(body.worked_by) ? body.worked_by.map(String) : [];
    let workedBy = [];
    if (requested.length) {
      const { data: activeStaff, error: sErr } = await supabase.from("staff").select("id").eq("active", true).in("id", requested);
      if (sErr) throw sErr;
      workedBy = (activeStaff || []).map((s) => s.id);
    }

    const result = await completeBooking(supabase, {
      bookingId,
      payment,
      recordedBy: adminSession?.admin?.id || null,
      actor: "admin",
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    // The job is completed and paid; a failure here must not undo it, so it is logged.
    if (workedBy.length) {
      try {
        await supabase.from("booking_staff").delete().eq("booking_id", bookingId);
        const { error: insErr } = await supabase.from("booking_staff").insert(workedBy.map((staff_id) => ({ booking_id: bookingId, staff_id })));
        if (insErr) throw insErr;
      } catch (crewErr) {
        console.error("admin-complete-booking: crew record failed", crewErr);
      }
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("admin-complete-booking error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
