import { sendBookingEmail } from "../../api/_sendEmail.js";
import { layout, loadCycleEmailContext, money, niceDate } from "./_cycleEmail.js";

/**
 * Sent when a member extends their window. manageToken is accepted for backwards compatibility;
 * links come from the plan itself.
 */
export async function sendCyclePushbackEmailCore(cycleId, _manageToken) {
  const c = await loadCycleEmailContext(cycleId);
  const fee = c.cycle.free_pushback ? 0 : Math.round(Number(c.price.base_price) * 0.15 * 100) / 100;
  const emailResult = await sendBookingEmail({
    to: c.email,
    subject: `Moon Auto Detailing — Your window is extended to ${niceDate(c.effectiveEnd)}`,
    html: layout({
      heading: "Your maintenance window has been extended",
      paragraphs: [
        `Hi ${c.firstName},`,
        `You now have until <b>${niceDate(c.effectiveEnd, true)}</b> to book your ${c.vehicle}'s maintenance visit.`,
        c.cycle.free_pushback
          ? `There's no extension fee, because your original window didn't have any open times.`
          : `A 15% extension fee (${money(fee)}) will be added to this visit.`,
        `This was your one extension for this window.`
      ],
      button: { label: "Book my service", url: c.bookUrl },
      footer: `<a href="${c.planUrl}">View your maintenance plan</a>`
    })
  });
  if (!emailResult?.success) throw new Error(emailResult?.error ?? "Email send failed");
  return emailResult;
}
