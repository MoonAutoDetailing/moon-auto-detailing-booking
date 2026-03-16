import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { formatBookingTimeRange } from "../time/formatBookingTime.js";
import { formatServiceName, pricingBlockHtml } from "./_shared.js";

const ADMIN_EMAIL = "moonautodetailing@gmail.com";

export async function sendAdminNewBookingAlertEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: booking, error } = await supabase
    .from("bookings")
    .select(`
      id,
      status,
      scheduled_start,
      scheduled_end,
      service_address,
      customer_notes,
      base_price,
      travel_fee,
      total_price,
      discount_code,
      discount_percent,
      discount_amount,
      customers(full_name, email, phone),
      vehicles(vehicle_make, vehicle_model, vehicle_year),
      service_variant:service_variants(
        price,
        service:services(category, level)
      )
    `)
    .eq("id", bookingId)
    .single();

  if (error || !booking) {
    throw new Error("Booking lookup failed for admin new booking alert");
  }

  const timeRange = formatBookingTimeRange(booking.scheduled_start, booking.scheduled_end);
  const serviceLabel = formatServiceName(booking);
  const pricingHtml = pricingBlockHtml({
    serviceLabel,
    price: booking.service_variant?.price ?? null,
    basePrice: booking.base_price ?? null,
    travelFee: booking.travel_fee ?? null,
    totalPrice: booking.total_price ?? null,
    discountCode: booking.discount_code ?? null,
    discountPercent: booking.discount_percent ?? null,
    discountAmount: booking.discount_amount ?? null
  });
  const vehicleText = booking.vehicles
    ? `${booking.vehicles.vehicle_year ?? ""} ${booking.vehicles.vehicle_make ?? ""} ${booking.vehicles.vehicle_model ?? ""}`.trim() || "—"
    : "—";
  const customerName = booking.customers?.full_name ?? "—";
  const customerEmail = booking.customers?.email ?? "—";
  const customerPhone = booking.customers?.phone ?? "—";
  const notesHtml = booking.customer_notes
    ? `<p><b>Customer notes:</b> ${String(booking.customer_notes).replace(/</g, "&lt;")}</p>`
    : "";

  const emailResult = await sendBookingEmail({
    to: ADMIN_EMAIL,
    subject: "New Booking Request — Moon Auto Detailing",
    html: `
      <h2>New booking request received</h2>
      <p>A new booking request is waiting in Pending Bookings.</p>
      <p><b>Booking ID:</b> ${booking.id}</p>
      <p><b>Customer:</b> ${customerName}</p>
      <p><b>Email:</b> ${customerEmail}</p>
      <p><b>Phone:</b> ${customerPhone}</p>
      <p><b>Vehicle:</b> ${vehicleText}</p>
      <p><b>Requested time:</b> ${timeRange}</p>
      <p><b>Service:</b> ${serviceLabel}</p>
      <p><b>Service address:</b> ${booking.service_address ?? "—"}</p>
      ${notesHtml}
      ${pricingHtml}
    `
  });
  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
