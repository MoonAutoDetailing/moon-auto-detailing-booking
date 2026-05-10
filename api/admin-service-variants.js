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
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data, error } = await supabase
      .from("service_variants")
      .select("id, vehicle_size, price, duration_minutes, service:services(category, level)")
      .eq("active", true)
      .order("vehicle_size", { ascending: true });

    if (error) throw error;

    return res.status(200).json({
      ok: true,
      service_variants: (data || []).map((v) => {
        const category = v.service?.category ?? null;
        const level = v.service?.level ?? null;
        return {
          service_variant_id: v.id,
          category,
          level,
          service_label: category ? `${category}${level != null ? ` Level ${level}` : ""}` : "Service",
          vehicle_size: v.vehicle_size,
          price: v.price,
          duration_minutes: v.duration_minutes
        };
      })
    });
  } catch (err) {
    console.error("admin-service-variants error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
