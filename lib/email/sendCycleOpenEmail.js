import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";

export async function sendCycleOpenEmailCore(cycleId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

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
        customers(full_name, email)
      )
    `)
    .eq("id", cycleId)
    .single();

  if (cycleErr || !cycle?.subscriptions?.customers?.email) {
    throw new Error("Cycle or customer lookup failed for cycle-open email");
  }

  const customer = cycle.subscriptions.customers;
  const windowEnd = cycle.pushback_used ? cycle.pushback_end_date : cycle.window_end_date;

  const emailResult = await sendBookingEmail({
    to: customer.email,
    subject: "Moon Auto Detailing — Your subscription window is open",
    html: `
      <h2>Time to book your next detail</h2>
      <p>Hi ${(customer.full_name || "").split(" ")[0] || "there"},</p>
      <p>Your subscription window is open. Book your next service by ${windowEnd || cycle.window_end_date}.</p>
      <p><b>Window:</b> ${cycle.window_start_date || "—"} to ${windowEnd || cycle.window_end_date || "—"}</p>
      <p>Book at your convenience to keep your subscription in good standing.</p>
    `
  });
  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
