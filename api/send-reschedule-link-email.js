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
  manage_token,
  reschedule_token,
  customers(email, full_name),
  service_variant:service_variants(
    price,
    service:services(category,level)
  )
`)
      .eq("id", bookingId)
      .single();

    if (error || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const firstName = booking.customers.full_name.split(" ")[0];
    const service = booking.service_variant?.service;
const serviceLabel = service ? `${service.category} Detail Level ${service.level}` : "Service";
const price = booking.service_variant?.price;

    await sendRescheduleLinkEmailCore({
  email: booking.customers.email,
  fullName: booking.customers.full_name,
  manageToken: booking.manage_token,
  rescheduleToken: booking.reschedule_token,
  serviceLabel,
  price
});


    return res.status(200).json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
