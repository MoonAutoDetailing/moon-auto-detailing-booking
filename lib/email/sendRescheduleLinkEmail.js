import { sendBookingEmail } from "../../api/_sendEmail.js";

export async function sendRescheduleLinkEmailCore({
  email,
  fullName,
  manageToken
}) {
  const firstName = fullName.split(" ")[0];

  const rebookingLink =
    "https://moon-auto-detailing-booking.vercel.app/index.html?reschedule_token=" +
    manageToken;

  await sendBookingEmail({
    to: email,
    subject: "Choose a new time for your detailing appointment",
    html: `
      <p>Hi ${firstName},</p>
      <p>Your appointment is ready to be rescheduled.</p>
      <p>Please choose a new time using the link below:</p>
      <p><a href="${rebookingLink}">${rebookingLink}</a></p>
      <p>Your service details are already saved — you only need to pick a new date and time.</p>
      <p>Moon Auto Detailing</p>
    `
  });
}
