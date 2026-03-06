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
    let adminAuthorized = false;
    try {
      adminAuthorized = await verifyAdmin(req);
    } catch (err) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!adminAuthorized) {
      return res.status(401).json({ error: "Unauthorized" });
    }

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

    // Subscription activation hook: activate subscription if this was its onboarding booking
    const { data: subscription } = await supabase
      .from("subscriptions")
      .select("id, status")
      .eq("activation_booking_id", bookingId)
      .maybeSingle();
    if (subscription && subscription.status === "pending_activation") {
      const { data: booking } = await supabase
        .from("bookings")
        .select("scheduled_start")
        .eq("id", bookingId)
        .single();
      if (booking?.scheduled_start) {
        const anchorDate = booking.scheduled_start.split("T")[0];
        await supabase
          .from("subscriptions")
          .update({
            status: "active",
            anchor_date: anchorDate
          })
          .eq("id", subscription.id);
        console.log("SUBSCRIPTION_ACTIVATED", {
          subscription_id: subscription.id,
          anchor_date: anchorDate
        });
      }
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("admin-complete-booking error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
