import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd } from "../../api/_subscriptions/lifecycle.js";
import { buildManageSubscriptionUrl } from "./_shared.js";

/**
 * Load cycle with subscription, customer, and activation booking manage_token.
 */
async function loadCycleWithManageToken(supabase, cycleId) {
  const { data: cycle, error: cycleErr } = await supabase
    .from("subscription_cycles")
    .select(`
      id,
      cycle_index,
      window_start_date,
      window_end_date,
      pushback_used,
      pushback_end_date,
      subscription_id,
      subscriptions(
        id,
        frequency,
        activation_booking_id,
        customers(full_name, email)
      )
    `)
    .eq("id", cycleId)
    .single();

  if (cycleErr || !cycle?.subscriptions?.customers?.email) {
    return { error: "Cycle or customer lookup failed" };
  }

  const { data: activationBooking, error: bookErr } = await supabase
    .from("bookings")
    .select("id, manage_token")
    .eq("id", cycle.subscriptions.activation_booking_id)
    .single();

  if (bookErr || !activationBooking?.manage_token) {
    return { error: "Activation booking or manage_token not found" };
  }

  return {
    cycle,
    customer: cycle.subscriptions.customers,
    manageToken: activationBooking.manage_token
  };
}

/**
 * Send reminder 1 email (3 days before effective end). Uses activation booking manage_token for Manage link.
 */
export async function sendCycleReminder1EmailCore(cycleId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const loaded = await loadCycleWithManageToken(supabase, cycleId);
  if (loaded.error) {
    throw new Error(loaded.error);
  }

  const { cycle, customer, manageToken } = loaded;
  const effectiveEnd = getEffectiveWindowEnd(cycle);
  const manageUrl = buildManageSubscriptionUrl(manageToken);

  const emailResult = await sendBookingEmail({
    to: customer.email,
    subject: "Moon Auto Detailing — Reminder: book your subscription service",
    html: `
      <h2>Your booking window is still open</h2>
      <p>Hi ${(customer.full_name || "").split(" ")[0] || "there"},</p>
      <p>This is a friendly reminder that your subscription booking window is open. Book by <b>${effectiveEnd || "—"}</b> to stay on track.</p>
      <p><b>Deadline:</b> ${effectiveEnd || "—"}</p>
      <p><a href="${manageUrl}">Manage Subscription</a></p>
    `
  });

  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
