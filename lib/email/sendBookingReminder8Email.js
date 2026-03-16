import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { formatServiceName } from "./_shared.js";

export async function sendBookingReminder8EmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: booking, error } = await supabase
    .from("bookings")
    .select(`
      id,
      scheduled_start,
      scheduled_end,
      service_address,
      customers(full_name, email),
      service_variant:service_variants(
        service:services(category, level)
      )
    `)
    .eq("id", bookingId)
    .single();

  if (error || !booking) {
    throw new Error("Booking lookup failed for 8h reminder");
  }

  const serviceLabel = formatServiceName(booking);
  const firstName = (booking.customers?.full_name || "").split(" ")[0] || "there";
  const startTime = new Date(booking.scheduled_start).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit"
  });

  const emailResult = await sendBookingEmail({
    to: booking.customers?.email,
    subject: "Moon Auto Detailing — Today: your appointment is in a few hours",
    html: `
      <h2>Your appointment is today</h2>
      <p>Hi ${firstName},</p>
      <p>Quick reminder: we’re scheduled to arrive at <b>${startTime} Eastern</b> for your ${serviceLabel}.</p>
      <p><b>Address:</b> ${booking.service_address ?? "—"}</p>
      <p>See you soon.</p>
    `
  });
  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
