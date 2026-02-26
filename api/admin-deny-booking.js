import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";
import { sendBookingDeniedEmailCore } from "../lib/email/sendBookingDeniedEmail.js";

export default async function handler(req, res) {
  try {
    // 🔐 Admin auth (throwing guard)
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

    // 1️⃣ Update booking status → denied
    const { error: updateError } = await supabase
      .from("bookings")
      .update({ status: "denied" })
      .eq("id", bookingId);

    if (updateError) {
      console.error("Failed updating booking:", updateError);
      return res.status(500).json({ error: "Failed to update booking" });
    }

    // 2️⃣ Send denied email (non-blocking)
    try {
      await sendBookingDeniedEmailCore(bookingId);
      console.log("Denied email sent");
    } catch (emailErr) {
      console.error("Denied email failed:", emailErr);
      // Do NOT fail endpoint if email fails
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("admin-deny-booking fatal error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
