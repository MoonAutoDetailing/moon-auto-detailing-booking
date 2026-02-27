import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";
import { sendBookingCompletedEmailCore } from "../lib/email/sendBookingCompletedEmail.js";


export default async function handler(req, res) {
  try {
    await verifyAdmin(req);

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({ error: "Missing bookingId" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    await supabase
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", bookingId);

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
