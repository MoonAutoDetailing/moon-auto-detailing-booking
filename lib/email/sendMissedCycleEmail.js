import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { buildManageSubscriptionUrl } from "./_shared.js";

export async function sendMissedCycleEmailCore(cycleId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: cycle, error: cycleErr } = await supabase
    .from("subscription_cycles")
    .select(`
      id,
      cycle_index,
      window_end_date,
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
    throw new Error("Cycle or customer lookup failed for missed-cycle email");
  }

  let manageUrl = null;
  let activationBookingId = cycle.subscriptions?.activation_booking_id;
  if (!activationBookingId && cycle.subscription_id) {
    const { data: sub } = await supabase.from("subscriptions").select("activation_booking_id").eq("id", cycle.subscription_id).single();
    activationBookingId = sub?.activation_booking_id;
  }
  if (activationBookingId) {
    const { data: actBooking } = await supabase
      .from("bookings")
      .select("manage_token")
      .eq("id", activationBookingId)
      .single();
    if (actBooking?.manage_token) {
      manageUrl = buildManageSubscriptionUrl(actBooking.manage_token);
    }
  }

  const customer = cycle.subscriptions.customers;

  const emailResult = await sendBookingEmail({
    to: customer.email,
    subject: "Moon Auto Detailing — Subscription window missed",
    html: `
      <h2>Your subscription window has closed</h2>
      <p>Hi ${(customer.full_name || "").split(" ")[0] || "there"},</p>
      <p>Your booking window for this cycle ended without a booking. Your next cycle discount may be reset per your subscription terms.</p>
      <p><b>Cycle end date:</b> ${cycle.window_end_date || "—"}</p>
      <p>Book in your next window to stay on track.</p>
      ${manageUrl ? `
      <p>You can manage your subscription here:</p>
      <p><a href="${manageUrl}">Manage Subscription</a></p>
      ` : ""}
    `
  });
  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
