import { sendBookingEmail } from "../../api/_sendEmail.js";
import { formatBookingTimeRange } from "../time/formatBookingTime.js";

export async function sendRescheduleSubmittedEmailCore({
  email,
  fullName,
  newStart,
  newEnd
}) {

  const firstName = fullName.split(" ")[0];

  const timeRange = formatBookingTimeRange(newStart, newEnd);

  await sendBookingEmail({
    to: email,
    subject: "Your new detailing time was received",
    html: `
      <p>Hi ${firstName},</p>

      <p>We received your new requested appointment time.</p>

      <p><b>Requested time:</b> ${timeRange}</p>

      <p>Our team will review availability and confirm your appointment shortly.</p>

      <p>You will receive another email once your new time is officially confirmed.</p>

      <p>Moon Auto Detailing</p>
    `
  });
}
