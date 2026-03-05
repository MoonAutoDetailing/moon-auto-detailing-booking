import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";
import { sendBookingCompletedEmailCore } from "../lib/email/sendBookingCompletedEmail.js";


export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const bookingId = body.booking_id || body.bookingId;

  if (!bookingId) {
    return res.status(400).json({ error: "Missing booking_id" });
  }

  req.body = { ...body, bookingId };

  try {
    await verifyAdmin(req);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { error: updateError } = await supabase
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", bookingId);
    if (updateError) {
      console.error("SUPABASE UPDATE FAILED", updateError);
      return res.status(500).json({ error: "Database update failed" });
    }

    // Send completion email (must succeed or roll back)
    const emailResult = await sendBookingCompletedEmailCore(bookingId);
    if (!emailResult?.success) {
      console.error("Completion email failed", emailResult?.error);
      await supabase
        .from("bookings")
        .update({ status: "confirmed" })
        .eq("id", bookingId);
      return res.status(500).json({ error: "Email failed; action rolled back" });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("admin-complete-booking error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
