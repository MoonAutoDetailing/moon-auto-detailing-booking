import { sendBookingEmail } from "../../api/_sendEmail.js";

export async function sendBookingConfirmedEmailCore({
  email,
  fullName,
  start,
  end,
  address
}) {
  await sendBookingEmail({
    to: email,
    subject: "Moon Auto Detailing — Booking Confirmed",
    html: `
      <h2>Your detailing appointment is confirmed</h2>
      <p>Hi ${fullName},</p>
      <p>Your appointment has been confirmed.</p>
      <p><b>Start:</b> ${new Date(start).toLocaleString()}</p>
      <p><b>End:</b> ${new Date(end).toLocaleString()}</p>
      <p><b>Address:</b> ${address}</p>
      <p>We look forward to servicing your vehicle.</p>
    `
  });
}
