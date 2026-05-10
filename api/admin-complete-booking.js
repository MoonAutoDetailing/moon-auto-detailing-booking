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

  // Payment fields (required: amount_collected + payment_method)
  const ALLOWED_PAYMENT_METHODS = ["Cash", "PayPal", "Venmo", "Check"];
  const amountCollectedNum = body.amount_collected != null ? Number(body.amount_collected) : NaN;
  const tipAmountRaw = body.tip_amount != null ? Number(body.tip_amount) : 0;
  const paymentMethod = String(body.payment_method ?? "").trim();
  const paymentNotes = body.payment_notes != null ? String(body.payment_notes).trim() : null;

  if (!Number.isFinite(amountCollectedNum) || amountCollectedNum < 0) {
    return res.status(400).json({ error: "amount_collected must be a non-negative number." });
  }
  if (!Number.isFinite(tipAmountRaw) || tipAmountRaw < 0) {
    return res.status(400).json({ error: "tip_amount must be a non-negative number." });
  }
  if (ALLOWED_PAYMENT_METHODS.indexOf(paymentMethod) === -1) {
    return res.status(400).json({ error: "Invalid payment_method." });
  }
  const amountCollected = Math.round(amountCollectedNum * 100) / 100;
  const tipAmount = Math.round(tipAmountRaw * 100) / 100;

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

    // Record payment (job_payments). Roll booking back if insert fails.
    const paymentInsert = {
      booking_id: bookingId,
      amount_collected: amountCollected,
      tip_amount: tipAmount,
      payment_method: paymentMethod
    };
    if (paymentNotes) paymentInsert.notes = paymentNotes;
    if (adminAuthorized && typeof adminAuthorized === "object" && adminAuthorized.admin?.id) {
      paymentInsert.recorded_by = adminAuthorized.admin.id;
    }
    const { data: paymentRow, error: paymentErr } = await supabase
      .from("job_payments")
      .insert(paymentInsert)
      .select("id")
      .single();
    if (paymentErr) {
      console.error("JOB_PAYMENT_INSERT_FAILED", paymentErr);
      await supabase
        .from("bookings")
        .update({ status: "confirmed" })
        .eq("id", bookingId);
      return res.status(500).json({ error: "Payment record failed; action rolled back" });
    }

    // Send completion email (must succeed or roll back)
    const emailResult = await sendBookingCompletedEmailCore(bookingId);
    if (!emailResult?.success) {
      console.error("Completion email failed", emailResult?.error);
      if (paymentRow?.id) {
        await supabase.from("job_payments").delete().eq("id", paymentRow.id);
      }
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

    // Subscription cycle completion: mark cycle completed and clear discount reset if applicable
    const { data: cycleBooking } = await supabase
      .from("subscription_cycle_bookings")
      .select("cycle_id")
      .eq("booking_id", bookingId)
      .maybeSingle();
    if (cycleBooking) {
      const cycleId = cycleBooking.cycle_id;
      await supabase
        .from("subscription_cycles")
        .update({ status: "completed" })
        .eq("id", cycleId);
      console.log("CYCLE_COMPLETED", { cycle_id: cycleId, booking_id: bookingId });
      const { data: cycle } = await supabase
        .from("subscription_cycles")
        .select("subscription_id")
        .eq("id", cycleId)
        .single();
      if (cycle) {
        const { data: sub } = await supabase
          .from("subscriptions")
          .select("id, discount_reset_required, completed_cycles_count")
          .eq("id", cycle.subscription_id)
          .single();
        if (sub) {
          const updates = { completed_cycles_count: (sub.completed_cycles_count ?? 0) + 1 };
          if (sub.discount_reset_required) {
            updates.discount_reset_required = false;
          }
          await supabase
            .from("subscriptions")
            .update(updates)
            .eq("id", sub.id);
        }
      }
    }

    console.log("JOB_PAYMENT_RECORDED", {
      booking_id: bookingId,
      amount_collected: amountCollected,
      tip_amount: tipAmount,
      payment_method: paymentMethod
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("admin-complete-booking error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
