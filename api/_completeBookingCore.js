// Completing a job: one code path for the admin page (admin-complete-booking) and the
// crew app (staff-complete-job).
//
// Order (unchanged from the original admin handler):
//   booking → completed, job_payments row, completion email (rolls everything back on
//   failure), CRM stage + review task, then maintenance-plan hook (never rolls back).
// Bookings that are already completed or cancelled are refused, and a rollback restores the
// booking's previous status instead of assuming "confirmed".

import { onBookingCompleted } from "./_subscriptions/cycleState.js";
import { sendBookingCompletedEmailCore } from "../lib/email/sendBookingCompletedEmail.js";
import { createFollowUpTaskIfMissing, reconcileCustomerLifecycle, syncCrmProfileStage } from "./_crmWorkflow.js";

export const ALLOWED_PAYMENT_METHODS = ["Cash", "PayPal", "Venmo", "Check"];
const NOT_COMPLETABLE = ["completed", "complete", "done", "cancelled", "denied"];

/** Validates payment fields from a request body. Returns { error } or { payment }. */
export function parsePayment(body) {
  const amountCollectedNum = body.amount_collected != null ? Number(body.amount_collected) : NaN;
  const tipAmountRaw = body.tip_amount != null && body.tip_amount !== "" ? Number(body.tip_amount) : 0;
  const paymentMethod = String(body.payment_method ?? "").trim();
  const paymentNotes = body.payment_notes != null ? String(body.payment_notes).trim() : null;

  if (!Number.isFinite(amountCollectedNum) || amountCollectedNum < 0) {
    return { error: "amount_collected must be a non-negative number." };
  }
  if (!Number.isFinite(tipAmountRaw) || tipAmountRaw < 0) {
    return { error: "tip_amount must be a non-negative number." };
  }
  if (ALLOWED_PAYMENT_METHODS.indexOf(paymentMethod) === -1) {
    return { error: "Invalid payment_method." };
  }
  return {
    payment: {
      amount_collected: Math.round(amountCollectedNum * 100) / 100,
      tip_amount: Math.round(tipAmountRaw * 100) / 100,
      payment_method: paymentMethod,
      notes: paymentNotes || null,
    },
  };
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function completeBooking(supabase, { bookingId, payment, recordedBy = null, actor = "admin", sendEmail = sendBookingCompletedEmailCore }) {
  const { data: current, error: loadErr } = await supabase
    .from("bookings")
    .select("id, status, customer_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (loadErr) throw loadErr;
  if (!current) return { ok: false, status: 404, error: "Booking not found" };
  if (NOT_COMPLETABLE.includes(current.status)) {
    return { ok: false, status: 409, error: `Booking is already ${current.status}` };
  }
  const previousStatus = current.status;

  const { data: updated, error: updateError } = await supabase
    .from("bookings")
    .update({ status: "completed" })
    .eq("id", bookingId)
    .eq("status", previousStatus)
    .select("id");
  if (updateError) {
    console.error("SUPABASE UPDATE FAILED", updateError);
    return { ok: false, status: 500, error: "Database update failed" };
  }
  if (!updated || updated.length === 0) {
    return { ok: false, status: 409, error: "Booking changed while completing; refresh and try again" };
  }

  const rollbackStatus = () =>
    supabase.from("bookings").update({ status: previousStatus }).eq("id", bookingId);

  // Record payment (job_payments). Roll booking back if insert fails.
  const paymentInsert = {
    booking_id: bookingId,
    amount_collected: payment.amount_collected,
    tip_amount: payment.tip_amount,
    payment_method: payment.payment_method,
  };
  if (payment.notes) paymentInsert.notes = payment.notes;
  if (recordedBy) paymentInsert.recorded_by = recordedBy;
  const { data: paymentRow, error: paymentErr } = await supabase
    .from("job_payments")
    .insert(paymentInsert)
    .select("id")
    .single();
  if (paymentErr) {
    console.error("JOB_PAYMENT_INSERT_FAILED", paymentErr);
    await rollbackStatus();
    return { ok: false, status: 500, error: "Payment record failed; action rolled back" };
  }

  // Send completion email (must succeed or roll back)
  const emailResult = await sendEmail(bookingId);
  if (!emailResult?.success) {
    console.error("Completion email failed", emailResult?.error);
    if (paymentRow?.id) {
      await supabase.from("job_payments").delete().eq("id", paymentRow.id);
    }
    await rollbackStatus();
    return { ok: false, status: 500, error: "Email failed; action rolled back" };
  }

  // CRM bookkeeping; failures are logged but the job stays completed.
  try {
    if (current.customer_id) {
      const { count, error: completedCountError } = await supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", current.customer_id)
        .in("status", ["completed", "complete", "done"]);
      if (completedCountError) throw completedCountError;
      await syncCrmProfileStage(supabase, current.customer_id, {
        lifecycle_stage: (count || 0) >= 2 ? "repeat_customer" : "completed_customer",
        status: "active",
      });
      await createFollowUpTaskIfMissing(supabase, {
        customerId: current.customer_id,
        bookingId,
        taskType: "review_request",
        dueAt: new Date().toISOString(),
        priority: "medium",
        notes: "Ask customer for a review after completed service.",
      });
      await reconcileCustomerLifecycle(supabase, current.customer_id);
    }
  } catch (crmErr) {
    console.error("[CRM] completion follow-up failed", crmErr);
  }

  // Maintenance plans: activate a pending subscription (first service) or complete the
  // linked cycle. Failures here must not undo the recorded payment.
  try {
    await onBookingCompleted(supabase, bookingId, { actor });
  } catch (cycleErr) {
    console.error("[CYCLE_STATE] completion hook failed", cycleErr);
  }

  console.log("JOB_PAYMENT_RECORDED", {
    booking_id: bookingId,
    amount_collected: payment.amount_collected,
    tip_amount: payment.tip_amount,
    payment_method: payment.payment_method,
    recorded_by: recordedBy,
  });

  return { ok: true };
}
