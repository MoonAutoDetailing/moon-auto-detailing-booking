import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { formatBookingTimeRange } from "../time/formatBookingTime.js";
import { formatServiceName, buildManageUrl } from "./_shared.js";

export async function sendBookingReminder48EmailCore(bookingId) {
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
      manage_token,
      customers(full_name, email),
      service_variant:service_variants(
        service:services(category, level)
      )
    `)
    .eq("id", bookingId)
    .single();

  if (error || !booking) {
    throw new Error("Booking lookup failed for 48h reminder");
  }

  const timeRange = formatBookingTimeRange(booking.scheduled_start, booking.scheduled_end);
  const serviceLabel = formatServiceName(booking);
  const firstName = (booking.customers?.full_name || "").split(" ")[0] || "there";
  const manageUrl = booking.manage_token ? buildManageUrl(booking.manage_token) : null;

  const emailResult = await sendBookingEmail({
    to: booking.customers?.email,
    subject: "Moon Auto Detailing — Reminder: your appointment is in 2 days",
    html: `
      <h2>Your detailing appointment is in 2 days</h2>
      <p>Hi ${firstName},</p>
      <p>This is a friendly reminder of your upcoming appointment.</p>
      <p><b>Date & time:</b> ${timeRange}</p>
      <p><b>Service:</b> ${serviceLabel}</p>
      <p><b>Address:</b> ${booking.service_address ?? "—"}</p>
      <p><strong>Important:</strong> Tomorrow is the last day to cancel or reschedule without penalty. We ask for at least 24 hours’ notice for any changes. After that, cancellations or reschedules may be subject to our policy.</p>
      <p>Please remove personal belongings from your vehicle before we arrive so we can complete your detail efficiently.</p>
      ${manageUrl ? `<p><a href="${manageUrl}">Manage your booking</a></p>` : ""}
      <p>We look forward to seeing you.</p>
    `
  });
  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
