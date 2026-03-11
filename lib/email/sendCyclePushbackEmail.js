import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd } from "../../api/_subscriptions/lifecycle.js";
import { buildManageSubscriptionUrl } from "./_shared.js";

/**
 * Send pushback confirmation email. Uses activation booking manage_token for Manage link.
 * @param {string} cycleId - subscription_cycles.id (after pushback update)
 * @param {string} manageToken - activation booking manage_token for the Manage link
 */
export async function sendCyclePushbackEmailCore(cycleId, manageToken) {
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
      pushback_used,
      pushback_end_date,
      free_pushback,
      subscription_id,
      subscriptions(
        id,
        frequency,
        customers(full_name, email)
      )
    `)
    .eq("id", cycleId)
    .single();

  if (cycleErr || !cycle?.subscriptions?.customers?.email) {
    throw new Error("Cycle or customer lookup failed for pushback email");
  }

  const customer = cycle.subscriptions.customers;
  const effectiveEnd = getEffectiveWindowEnd(cycle);
  const manageUrl = buildManageSubscriptionUrl(manageToken);

  const freeText = cycle.free_pushback === true
    ? " This pushback was applied at no extra charge (no availability was found in your window)."
    : "";

  const emailResult = await sendBookingEmail({
    to: customer.email,
    subject: "Moon Auto Detailing — Cycle extended (pushback confirmed)",
    html: `
      <h2>Your booking window has been extended</h2>
      <p>Hi ${(customer.full_name || "").split(" ")[0] || "there"},</p>
      <p>Your subscription cycle has been extended. You now have until <b>${effectiveEnd || cycle.pushback_end_date || "—"}</b> to book.</p>
      <p><b>New deadline:</b> ${effectiveEnd || "—"}</p>
      ${freeText ? `<p>${freeText}</p>` : ""}
      <p>Manage your subscription and book when ready:</p>
      <p><a href="${manageUrl}">Manage Subscription</a></p>
    `
  });

  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
