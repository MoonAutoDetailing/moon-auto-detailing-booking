import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";

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

    // trigger completion email
    try {
      await fetch(`${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : ""}/api/send-booking-completed-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: bookingId })
      });
    } catch (err) {
      console.error("Completion email failed", err);
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("admin-complete-booking error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
