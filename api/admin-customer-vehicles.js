import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const customerId = String(req.query.customer_id || "").trim();
    if (!customerId) return res.status(400).json({ ok: false, error: "Missing customer_id" });

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data, error } = await supabase
      .from("vehicles")
      .select("id, vehicle_year, vehicle_make, vehicle_model, vehicle_size")
      .eq("customer_id", customerId)
      .order("vehicle_year", { ascending: false });

    if (error) throw error;

    return res.status(200).json({
      ok: true,
      vehicles: (data || []).map((v) => ({
        id: v.id,
        year: v.vehicle_year,
        make: v.vehicle_make,
        model: v.vehicle_model,
        vehicle_size: v.vehicle_size
      }))
    });
  } catch (err) {
    console.error("admin-customer-vehicles error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
