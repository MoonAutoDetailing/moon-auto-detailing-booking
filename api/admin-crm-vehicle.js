import crypto from "crypto";
import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function cleanYear(value) {
  const text = clean(value);
  if (!text) return null;
  const year = Number(text);
  return Number.isFinite(year) ? year : null;
}

function vehiclePayload(body, includeCustomer = false) {
  const payload = {
    vehicle_year: cleanYear(body.year ?? body.vehicle_year),
    vehicle_make: clean(body.make ?? body.vehicle_make),
    vehicle_model: clean(body.model ?? body.vehicle_model),
    vehicle_size: clean(body.vehicle_size),
    license_plate: clean(body.license_plate)
  };
  if (includeCustomer) payload.customer_id = clean(body.customer_id);
  if (clean(body.color)) payload.vehicle_color = clean(body.color);
  if (clean(body.notes)) payload.notes = clean(body.notes);
  return payload;
}

function baseVehiclePayload(payload) {
  const { vehicle_color, notes, ...base } = payload;
  return base;
}

async function writeVehicle(queryBuilder, payload) {
  const full = await queryBuilder(payload).select("*").single();
  if (!full.error) return full.data;

  const base = await queryBuilder(baseVehiclePayload(payload)).select("*").single();
  if (base.error) throw full.error;
  return base.data;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-crm-vehicle: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const action = clean(body.action);
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    if (action === "create") {
      const customerId = clean(body.customer_id);
      if (!customerId) {
        return res.status(400).json({ ok: false, error: "Missing customer_id" });
      }

      const { data: customer, error: customerError } = await supabase
        .from("customers")
        .select("id")
        .eq("id", customerId)
        .maybeSingle();
      if (customerError) throw customerError;
      if (!customer) {
        return res.status(404).json({ ok: false, error: "Customer not found" });
      }

      const payload = {
        id: crypto.randomUUID(),
        ...vehiclePayload(body, true)
      };
      const vehicle = await writeVehicle(
        (insertPayload) => supabase.from("vehicles").insert([insertPayload]),
        payload
      );
      return res.status(200).json({ ok: true, vehicle });
    }

    if (action === "update") {
      const vehicleId = clean(body.vehicle_id);
      if (!vehicleId) {
        return res.status(400).json({ ok: false, error: "Missing vehicle_id" });
      }

      const vehicle = await writeVehicle(
        (updatePayload) => supabase.from("vehicles").update(updatePayload).eq("id", vehicleId),
        vehiclePayload(body)
      );
      return res.status(200).json({ ok: true, vehicle });
    }

    return res.status(400).json({ ok: false, error: "Missing or invalid action" });
  } catch (err) {
    console.error("admin-crm-vehicle error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
