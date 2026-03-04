import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { formatBookingTimeRange } from "../time/formatBookingTime.js";
import { formatServiceName, pricingBlockHtml } from "./_shared.js";

export async function sendBookingCreatedEmailCore(bookingId) {
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
      manage_token,
      base_price,
      travel_fee,
      total_price,
      customers(full_name,email),
      vehicles(vehicle_make,vehicle_model,vehicle_year),
      service_variant:service_variants(
        price,
        service:services(category,level)
      )
    `)
    .eq("id", bookingId)
    .single();

  if (error || !booking) {
    throw new Error("Booking lookup failed for created email");
  }

  const timeRange = formatBookingTimeRange(booking.scheduled_start, booking.scheduled_end);
  const serviceLabel = formatServiceName(booking);
  const pricingHtml = pricingBlockHtml({
    serviceLabel,
    price: booking.service_variant?.price ?? null,
    basePrice: booking.base_price ?? null,
    travelFee: booking.travel_fee ?? null,
    totalPrice: booking.total_price ?? null
  });
  const vehicleText = booking.vehicles
    ? `${booking.vehicles.vehicle_year ?? ""} ${booking.vehicles.vehicle_make ?? ""} ${booking.vehicles.vehicle_model ?? ""}`.trim() || "—"
    : "—";
  const priceFormatted = booking.total_price != null
    ? `$${Number(booking.total_price).toFixed(2)}`
    : (booking.service_variant?.price != null ? `$${Number(booking.service_variant.price).toFixed(2)}` : "—");

  const emailResult = await sendBookingEmail({
    to: booking.customers?.email,
    subject: "Moon Auto Detailing — Booking Request Received",
    html: `
        <h2>We received your booking request</h2>
        <p>Hi ${(booking.customers?.full_name || "").split(" ")[0] || "there"},</p>
        <p>Your detailing request has been received and is awaiting confirmation.</p>

        <p><b>Appointment Time:</b> ${timeRange}</p>
        <p><b>Address:</b> ${booking.service_address ?? "—"}</p>
        <p><b>Service:</b> ${serviceLabel}</p>
        <p><b>Vehicle:</b> ${vehicleText}</p>
        <p><b>Total (cash only):</b> ${priceFormatted}</p>

        ${pricingHtml}

        <p>We will confirm your appointment shortly.</p>
      `
  });
  if (!emailResult?.success) {
    throw new Error(emailResult?.error ?? "Email send failed");
  }
  return emailResult;
}
