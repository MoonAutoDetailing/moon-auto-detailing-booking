import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  // CORS (public endpoint)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    // Service role client (server-side secure)
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    // =========================
    // Fetch booking by token
    // =========================
    const { data: booking, error } = await supabase
      .from("bookings")
      .select(`
        id,
        scheduled_start,
        scheduled_end,
        service_address,
        status,
        google_event_html_link,
        customers:customer_id (
          full_name,
          phone
        ),
        vehicles:vehicle_id (
          vehicle_year,
          vehicle_make,
          vehicle_model
        ),
        service_variants:service_variant_id (
          duration_minutes,
          services:service_id (
            category,
            level
          )
        )
      `)
      .eq("manage_token", token)
      .single();

    if (error || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // =========================
    // Sanitize response
    // =========================
    const service = booking.service_variants?.services;
    const vehicle = booking.vehicles;

    const serviceLabel = service
      ? `${service.category} Detail Level ${service.level}`
      : "Service";

    const vehicleLabel = vehicle
      ? `${vehicle.vehicle_year || ""} ${vehicle.vehicle_make || ""} ${vehicle.vehicle_model || ""}`.trim()
      : "";

    return res.status(200).json({
      id: booking.id,
      status: booking.status,
      scheduled_start: booking.scheduled_start,
      scheduled_end: booking.scheduled_end,
      service_address: booking.service_address,
      google_event_html_link: booking.google_event_html_link,
      customer_name: booking.customers?.full_name ?? "",
      phone: booking.customers?.phone ?? "",
      vehicle: vehicleLabel,
      service: serviceLabel
    });

  } catch (err) {
    console.error("manage-booking-get error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
