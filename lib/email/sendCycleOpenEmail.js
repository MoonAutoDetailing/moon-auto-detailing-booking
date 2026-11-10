import { sendBookingEmail } from "../../api/_sendEmail.js";
import { layout, loadCycleEmailContext, niceDate, priceSentence } from "./_cycleEmail.js";

/** Sent once, 7 days before a member's service window starts: booking is open. */
export async function sendCycleOpenEmailCore(cycleId) {
  const c = await loadCycleEmailContext(cycleId);
  const range = `${niceDate(c.cycle.window_start_date)} – ${niceDate(c.effectiveEnd)}`;
  const emailResult = await sendBookingEmail({
    to: c.email,
    subject: `Moon Auto Detailing — Book your next maintenance visit (${range})`,
    html: layout({
      heading: "Your next maintenance window is ready to book",
      paragraphs: [
        `Hi ${c.firstName},`,
        `It's time to schedule the next ${c.plan.categoryLabel.toLowerCase()} maintenance detail for your ${c.vehicle}.`,
        `<b>Your service window: ${range}</b><br/>Pick any weekday in that window. Appointments need at least 24 hours' notice.`,
        priceSentence(c.price)
      ],
      button: { label: "Book my service", url: c.bookUrl },
      footer: `You can also see your plan and history any time: <a href="${c.planUrl}">your maintenance plan</a>.`
    })
  });
  if (!emailResult?.success) throw new Error(emailResult?.error ?? "Email send failed");
  return emailResult;
}
