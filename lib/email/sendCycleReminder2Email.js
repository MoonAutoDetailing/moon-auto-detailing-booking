import { sendBookingEmail } from "../../api/_sendEmail.js";
import { layout, loadCycleEmailContext, niceDate } from "./_cycleEmail.js";

/** Sent the day before the window closes, only if the member hasn't booked. */
export async function sendCycleReminder2EmailCore(cycleId) {
  const c = await loadCycleEmailContext(cycleId);
  const closes = niceDate(c.effectiveEnd, true);
  const canExtend = !c.cycle.pushback_used;
  const emailResult = await sendBookingEmail({
    to: c.email,
    subject: `Moon Auto Detailing — Last chance: your maintenance window closes ${niceDate(c.effectiveEnd)}`,
    html: layout({
      heading: "Your maintenance window closes tomorrow",
      paragraphs: [
        `Hi ${c.firstName},`,
        `Your service window for your ${c.vehicle} closes <b>${closes}</b>, and we don't have a booking yet.`,
        canExtend
          ? `Can't make it? From your plan page you can extend your window once by 5 business days (a 15% extension fee applies, unless there were no open times in your window).`
          : `If the window closes without a booking, your next visit is charged at full price, and member pricing returns after that.`
      ],
      button: { label: "Book my service", url: c.bookUrl },
      footer: `<a href="${c.planUrl}">View your maintenance plan</a>`
    })
  });
  if (!emailResult?.success) throw new Error(emailResult?.error ?? "Email send failed");
  return emailResult;
}
