import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { formatBookingTimeRange } from "../time/formatBookingTime.js";
import { formatServiceName, pricingBlockHtml } from "./_shared.js";

export async function sendBookingCompletedEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await supabase
    .from("bookings")
    .select(`
      scheduled_start,
      scheduled_end,
      service_address,
      base_price,
      travel_fee,
      total_price,
      customers!bookings_customer_id_fkey (
        full_name,
        email
      ),
      vehicles(vehicle_year,vehicle_make,vehicle_model),
      service_variant:service_variants (
  price,
  service:services (category, level)
)
    `)
    .eq("id", bookingId)
    .single();

  if (error || !data?.customers) {
    throw new Error("Failed to load booking for completion email");
  }

  const serviceLabel = formatServiceName(data);
  const pricingHtml = pricingBlockHtml({
    serviceLabel,
    price: data.service_variant?.price,
    basePrice: data.base_price ?? null,
    travelFee: data.travel_fee ?? null,
    totalPrice: data.total_price ?? null
  });
  const vehicleText = data.vehicles
    ? `${data.vehicles.vehicle_year ?? ""} ${data.vehicles.vehicle_make ?? ""} ${data.vehicles.vehicle_model ?? ""}`.trim() || "—"
    : "—";
  const scheduledDateTime = data.scheduled_start && data.scheduled_end
    ? formatBookingTimeRange(data.scheduled_start, data.scheduled_end)
    : "—";

  const emailResult = await sendBookingEmail({
    to: data.customers?.email,
    subject: "Thank you for choosing and trusting Moon Auto Detailing with your ride today.",
    html: `
      <h2>Thank you for your business!</h2>
      <p>Hi ${data.customers?.full_name ?? "there"},</p>
      <p>Your detailing service has been completed.</p>
      <p><b>Service:</b> ${serviceLabel}</p>
      <p><b>Vehicle:</b> ${vehicleText}</p>
      <p><b>Scheduled was:</b> ${scheduledDateTime}</p>

      ${pricingHtml}

      <p>We would love your feedback!:</p>
      <p><a href="https://g.page/r/Cf7sALGmq14REAE/review">Leave a Review</a></p>

      <p>The best way to keep your vehicle shining all year long is with our maintainance details! Check them out here.</p>
      <p><a href="https://moonautodetailing.com/monthly-detailing-service">


        -Moon Auto Detailing team
      </a></p>
    `
  });
  if (!emailResult?.success) {
    console.error("[EMAIL] status=failure", emailResult?.error);
  } else {
    console.log("[EMAIL] status=success id=", emailResult.id);
  }
  return emailResult;
}
