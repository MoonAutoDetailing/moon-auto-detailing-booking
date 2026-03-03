import { createClient } from "@supabase/supabase-js";
import { sendBookingEmail } from "./_sendEmail.js";
import { formatBookingTimeRange } from "../lib/time/formatBookingTime.js";
import { formatServiceName, pricingBlockHtml } from "../lib/email/_shared.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const bookingId = req.body?.bookingId ?? req.body?.booking_id;
    if (!bookingId) return res.status(400).json({ message: "Missing bookingId" });

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
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
      console.error("Booking lookup failed:", error);
      return res.status(404).json({ message: "Booking not found" });
    }

    const timeRange = formatBookingTimeRange(booking.scheduled_start, booking.scheduled_end);

    const serviceLabel = formatServiceName(booking);

    const pricingHtml = pricingBlockHtml({
      serviceLabel,
      price: booking.service_variant?.price ?? null
    });

    const vehicleText = booking.vehicles
      ? `${booking.vehicles.vehicle_year ?? ""} ${booking.vehicles.vehicle_make ?? ""} ${booking.vehicles.vehicle_model ?? ""}`.trim() || "—"
      : "—";
    const priceFormatted = booking.service_variant?.price != null
      ? `$${Number(booking.service_variant.price).toFixed(2)}`
      : "—";

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
      console.error("[EMAIL] status=failure", emailResult?.error);
      return res.status(500).json({ ok: false, message: "Email send failed" });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-booking-created-email error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}
