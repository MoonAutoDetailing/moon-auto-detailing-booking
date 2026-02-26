import { createClient } from "@supabase/supabase-js";
import { sendBookingEmail } from "../../api/_sendEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

export async function sendRescheduleSelectedEmailCore(bookingId) {
  const { data: booking } = await supabase
    .from("bookings")
    .select(`
      scheduled_start,
      scheduled_end,
      service_address,
      customers:customer_id ( full_name, email, phone ),
      vehicles:vehicle_id ( vehicle_year, vehicle_make, vehicle_model )
    `)
    .eq("id", bookingId)
    .single();

  if (!booking) return;

  const start = new Date(booking.scheduled_start)
    .toLocaleString("en-US", { timeZone: "America/New_York" });

  const end = new Date(booking.scheduled_end)
    .toLocaleString("en-US", { timeZone: "America/New_York" });

  const emailResult = await sendBookingEmail({
    to: process.env.BUSINESS_EMAIL, // your inbox
    subject: "Customer selected a new time (Reschedule)",
    html: `
      <h2>Customer selected a new time</h2>
      <p><b>Name:</b> ${booking.customers.full_name}</p>
      <p><b>Phone:</b> ${booking.customers.phone}</p>
      <p><b>Email:</b> ${booking.customers.email}</p>
      <p><b>Vehicle:</b> ${booking.vehicles.vehicle_year} ${booking.vehicles.vehicle_make} ${booking.vehicles.vehicle_model}</p>
      <p><b>Address:</b> ${booking.service_address}</p>
      <p><b>New Time:</b> ${start} → ${end}</p>
    `
  });
  if (!emailResult?.success) {
    console.error("[EMAIL] status=failure", emailResult?.error);
  } else {
    console.log("[EMAIL] status=success id=", emailResult.id);
  }
}
