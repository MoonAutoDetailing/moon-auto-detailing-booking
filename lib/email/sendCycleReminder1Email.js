import { sendBookingEmail } from "../../api/_sendEmail.js";
import { layout, loadCycleEmailContext, niceDate, priceSentence } from "./_cycleEmail.js";

/** Sent 3 days before the window closes, only if the member hasn't booked. */
export async function sendCycleReminder1EmailCore(cycleId) {
  const c = await loadCycleEmailContext(cycleId);
  const closes = niceDate(c.effectiveEnd, true);
  const emailResult = await sendBookingEmail({
    to: c.email,
    subject: `Moon Auto Detailing — Reminder: book your maintenance visit by ${niceDate(c.effectiveEnd)}`,
    html: layout({
      heading: "Don't forget to book your maintenance visit",
      paragraphs: [
        `Hi ${c.firstName},`,
        `We haven't seen a booking yet for your ${c.vehicle}. Your current service window closes <b>${closes}</b>.`,
        priceSentence(c.price),
        `Already booked another way? Just reply to this email and we'll attach it to your plan.`
      ],
      button: { label: "Book my service", url: c.bookUrl },
      footer: `<a href="${c.planUrl}">View your maintenance plan</a>`
    })
  });
  if (!emailResult?.success) throw new Error(emailResult?.error ?? "Email send failed");
  return emailResult;
}
