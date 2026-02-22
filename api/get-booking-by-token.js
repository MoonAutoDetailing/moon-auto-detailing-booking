import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY") // server-only key
);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    // Fetch booking + customer info
    const { data, error } = await supabase
      .from("bookings")
      .select(`
  id,
  scheduled_start,
  scheduled_end,
  service_address,
  status,
  service_id,
  service_name,
  service_duration,
  vehicle_size,
  package_type,
  customers (
    full_name,
    email,
    phone
  )
`)
      .eq("manage_token", token)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Booking not found" });
    }

    return res.status(200).json({ booking: data });

  } catch (err) {
    console.error("get-booking-by-token error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
