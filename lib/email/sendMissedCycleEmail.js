import { sendBookingEmail } from "../../api/_sendEmail.js";
import { layout, loadCycleEmailContext, money, niceDate } from "./_cycleEmail.js";

/** Sent once when a window ends with no booking. */
export async function sendMissedCycleEmailCore(cycleId) {
  const c = await loadCycleEmailContext(cycleId);
  const range = `${niceDate(c.cycle.window_start_date)} – ${niceDate(c.effectiveEnd)}`;
  const emailResult = await sendBookingEmail({
    to: c.email,
    subject: "Moon Auto Detailing — We missed you this time",
    html: layout({
      heading: "Your maintenance window has closed",
      paragraphs: [
        `Hi ${c.firstName},`,
        `Your ${range} service window for your ${c.vehicle} ended without an appointment.`,
        `Under your plan, your next visit is charged at full price (${money(c.price.full_price)}). Member pricing${c.price.member_price ? ` of ${money(c.price.member_price)}` : ""} picks back up right after that visit.`,
        `We'll email you as soon as your next window opens for booking. If this doesn't look right, just reply and we'll sort it out.`
      ],
      footer: `<a href="${c.planUrl}">View your maintenance plan</a>`
    })
  });
  if (!emailResult?.success) throw new Error(emailResult?.error ?? "Email send failed");
  return emailResult;
}
