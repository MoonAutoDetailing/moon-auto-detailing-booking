import crypto from "crypto";
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

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const customerId = String(req.body?.customer_id || "").trim();
    const yearRaw = req.body?.year ?? req.body?.vehicle_year;
    const year = yearRaw !== undefined && yearRaw !== null && String(yearRaw).trim() !== "" ? Number(yearRaw) : null;
    const make = String(req.body?.make ?? req.body?.vehicle_make ?? "").trim() || null;
    const model = String(req.body?.model ?? req.body?.vehicle_model ?? "").trim() || null;
    const vehicleSize = String(req.body?.vehicle_size || "").trim().toLowerCase();

    if (!customerId || !vehicleSize) {
      return res.status(400).json({ ok: false, error: "customer_id and vehicle_size are required" });
    }
    if (!["compact", "midsized", "oversized"].includes(vehicleSize)) {
      return res.status(400).json({ ok: false, error: "Invalid vehicle_size" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: customer, error: customerErr } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customerId)
      .maybeSingle();

    if (customerErr) throw customerErr;
    if (!customer) return res.status(404).json({ ok: false, error: "Customer not found" });

    const { data: created, error: createErr } = await supabase
      .from("vehicles")
      .insert([{
        id: crypto.randomUUID(),
        customer_id: customerId,
        vehicle_year: Number.isFinite(year) ? year : null,
        vehicle_make: make,
        vehicle_model: model,
        vehicle_size: vehicleSize
      }])
      .select("id, vehicle_year, vehicle_make, vehicle_model, vehicle_size")
      .single();

    if (createErr) throw createErr;

    return res.status(200).json({
      ok: true,
      vehicle: {
        id: created.id,
        year: created.vehicle_year,
        make: created.vehicle_make,
        model: created.vehicle_model,
        vehicle_size: created.vehicle_size
      }
    });
  } catch (err) {
    console.error("admin-create-vehicle error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
