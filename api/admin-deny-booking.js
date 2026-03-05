import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";
import { sendBookingDeniedEmailCore } from "../lib/email/sendBookingDeniedEmail.js";

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
    // 🔐 Admin auth (throwing guard)
    await verifyAdmin(req);

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

    // 2️⃣ Send denied email (must succeed or roll back)
    const emailResult = await sendBookingDeniedEmailCore(bookingId);
    if (!emailResult?.success) {
      console.error("Denied email failed:", emailResult?.error);
      await supabase
        .from("bookings")
        .update({ status: "pending" })
        .eq("id", bookingId);
      return res.status(500).json({ error: "Email failed; action rolled back" });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("admin-deny-booking fatal error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
