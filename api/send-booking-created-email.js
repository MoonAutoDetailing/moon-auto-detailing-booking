import { createClient } from "@supabase/supabase-js";
import { sendBookingEmail } from "./_sendEmail.js";
import { formatBookingTimeRange } from "../lib/time/formatBookingTime.js";
import { buildManageUrl, pricingBlockHtml } from "../lib/email/_shared.js";

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
    const { booking_id } = req.body;
    if (!booking_id) return res.status(400).json({ message: "Missing booking_id" });

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: booking, error } = await supabase
      .from("bookings")
      .select(`
        id,
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
      .eq("id", booking_id)
      .single();

    if (error || !booking) {
      console.error("Booking lookup failed:", error);
      return res.status(404).json({ message: "Booking not found" });
    }

    const manageUrl = buildManageUrl(booking.manage_token);
    const timeRange = formatBookingTimeRange(booking.scheduled_start, booking.scheduled_end);

    const serviceLabel =
      booking.service_variant?.service
        ? `${booking.service_variant.service.category} Level ${booking.service_variant.service.level}`
        : "Service";

    const pricingHtml = pricingBlockHtml({
      serviceLabel,
      price: booking.service_variant?.price ?? null
    });

    const emailResult = await sendBookingEmail({
      to: booking.customers.email,
      subject: "Moon Auto Detailing — Booking Request Received",
      html: `
        <h2>We received your booking request</h2>
        <p>Hi ${(booking.customers.full_name || "").split(" ")[0] || "there"},</p>
        <p>Your detailing request has been received and is awaiting confirmation.</p>

        <p><b>Appointment Time:</b> ${timeRange}</p>
        <p><b>Address:</b> ${booking.service_address}</p>

        ${pricingHtml}

        <p style="margin-top:16px">
          You can manage your booking here:<br/>
          <a href="${manageUrl}">${manageUrl}</a>
        </p>

        <p>We will confirm your appointment shortly.</p>
      `
    });
    if (!emailResult?.success) {
      console.error("[EMAIL] status=failure", emailResult?.error);
    } else {
      console.log("[EMAIL] status=success id=", emailResult.id);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-booking-created-email error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}
