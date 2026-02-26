import { createClient } from "@supabase/supabase-js";
import { sendBookingEmail } from "./_sendEmail.js";
import { sendRescheduleLinkEmailCore } from "../lib/email/sendRescheduleLinkEmail.js";


function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY
    );

    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({ error: "Missing bookingId" });
    }

    // Fetch booking + customer
    const { data: booking, error } = await supabase
  .from("bookings")
  .select(`
    id,
    reschedule_token,
    manage_token,
    customers:customer_id(full_name,email),
    service_variants:service_variant_id(
      price,
      services:service_id(category,level)
    )
  `)
  .eq("reschedule_token", reschedule_token)
  .single();

    if (error || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const firstName = booking.customers.full_name.split(" ")[0];
    const service = booking.service_variants?.services;
const serviceLabel = service
  ? `${service.category} Detail ${service.level}`
  : "Service";

const price = booking.service_variants?.price ?? null;

    const serviceLabel = booking.service_variant?.service
  ? `${booking.service_variant.service.category} Detail ${booking.service_variant.service.level}`
  : "Service";

const price = booking.service_variant?.price ?? null;

    await sendRescheduleLinkEmailCore({
  email: booking.customers.email,
  fullName: booking.customers.full_name,
  rescheduleUrl,
  manageUrl,
  serviceLabel,
  price
});

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
