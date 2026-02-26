import { createClient } from "@supabase/supabase-js";
import { sendBookingEmail } from "./_sendEmail.js";
import { formatBookingTimeRange } from "../lib/time/formatBookingTime.js";
import { pricingBlockHtml } from "../lib/email/_shared.js";
import { buildManageUrl } from "../lib/email/_shared.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  // Support internal server calls (mock res has no setHeader)
  if (res?.setHeader) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res?.status ? res.status(405).end() : null;
  }


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
    customers:customer_id(full_name,email),
    service_variants:service_variant_id(
      price,
      services:service_id(category,level)
    )
  `)
  .eq("id", booking_id)
  .single();
    
    if (error || !booking) {
      console.error("Booking lookup failed:", error);
      return res.status(404).json({ message: "Booking not found" });
    }
    const timeRange = formatBookingTimeRange(booking.scheduled_start, booking.scheduled_end);
        const manageUrl = buildManageUrl(booking.manage_token);

    const serviceLabel = booking.service_variants?.services
      ? `${booking.service_variants.services.category} ${booking.service_variants.services.level}`
      : "Service";

    const pricingBlock = pricingBlockHtml({
      serviceLabel,
      price: booking.service_variants?.price
    });

    const emailResult = await sendBookingEmail({
  to: booking.customers.email,
  subject: "Moon Auto Detailing — Booking Confirmed",
    html: `
    <h2>Your detailing appointment is confirmed</h2>
    <p>Hi ${booking.customers.full_name},</p>
    <p>Your appointment has been confirmed for:</p>
    <p><b>${timeRange}</b></p>
    <p><b>Address:</b> ${booking.service_address}</p>
    ${pricingBlock}
    <p>
      Manage your booking:<br/>
      <a href="${manageUrl}">${manageUrl}</a>
    </p>
    <p>We look forward to servicing your vehicle.</p>
  `
});
    if (!emailResult?.success) {
      console.error("[EMAIL] status=failure", emailResult?.error);
    } else {
      console.log("[EMAIL] status=success id=", emailResult.id);
    }
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("send-booking-confirmed-email error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}
