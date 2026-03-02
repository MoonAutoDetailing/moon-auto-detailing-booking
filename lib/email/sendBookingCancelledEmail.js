import { sendBookingEmail } from "../../api/_sendEmail.js";
import { createClient } from "@supabase/supabase-js";
import { formatBookingTimeRange } from "../time/formatBookingTime.js";
import { formatServiceName, pricingBlockHtml } from "./_shared.js";

export async function sendBookingCancelledEmailCore(bookingId) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data } = await supabase
    .from("bookings")
    .select(`
      scheduled_start,
      scheduled_end,
      customers(full_name,email),
      vehicles(vehicle_year,vehicle_make,vehicle_model),
      service_variant:service_variants (
  price,
  service:services (category, level)
)
    `)
    .eq("id", bookingId)
    .single();

  const firstName = data.customers?.full_name?.split(" ")[0] ?? "there";
  const serviceLabel = formatServiceName(data);
  const pricingHtml = pricingBlockHtml({ serviceLabel, price: data.service_variant?.price });
  const vehicleText = data.vehicles
    ? `${data.vehicles.vehicle_year ?? ""} ${data.vehicles.vehicle_make ?? ""} ${data.vehicles.vehicle_model ?? ""}`.trim() || "—"
    : "—";
  const scheduledDateTime = data.scheduled_start && data.scheduled_end
    ? formatBookingTimeRange(data.scheduled_start, data.scheduled_end)
    : "—";

  const emailResult = await sendBookingEmail({
    to: data.customers?.email,
    subject: "Your appointment has been cancelled",
    html: `
      <p>Hi ${firstName},</p>
      <p>Your Moon Auto Detailing appointment has been cancelled.</p>
      <p><b>Service:</b> ${serviceLabel}</p>
      <p><b>Vehicle:</b> ${vehicleText}</p>
      <p><b>Was scheduled:</b> ${scheduledDateTime}</p>
      ${pricingHtml}
      <p>If this was a mistake, you can book again anytime.</p>
      <p>Moon Auto Detailing</p>
    `
  });
  if (!emailResult?.success) {
    console.error("[EMAIL] status=failure", emailResult?.error);
  } else {
    console.log("[EMAIL] status=success id=", emailResult.id);
  }
  return emailResult;
}
