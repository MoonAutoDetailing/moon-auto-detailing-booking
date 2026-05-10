import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").trim();
}

function normalizeAddress(value) {
  return String(value || "").trim();
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
    const fullName = String(req.body?.full_name || "").trim();
    const email = normalizeEmail(req.body?.email);
    const phone = normalizePhone(req.body?.phone);
    const address = normalizeAddress(req.body?.address || req.body?.customer_address || req.body?.service_address);

    if (!fullName || !email) {
      return res.status(400).json({ ok: false, error: "full_name and email are required" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: existing, error: existingErr } = await supabase
      .from("customers")
      .select("id, full_name, email, phone")
      .ilike("email", email)
      .limit(1)
      .maybeSingle();

    if (existingErr) throw existingErr;

    if (existing) {
      return res.status(200).json({
        ok: true,
        customer: {
          id: existing.id,
          full_name: existing.full_name,
          email: existing.email,
          phone: existing.phone
        }
      });
    }

    const { data: created, error: createErr } = await supabase
      .from("customers")
      .insert([{
        id: crypto.randomUUID(),
        full_name: fullName,
        email,
        phone: phone || null,
        address: address || ""
      }])
      .select("id, full_name, email, phone")
      .single();

    if (createErr) throw createErr;

    return res.status(200).json({
      ok: true,
      customer: {
        id: created.id,
        full_name: created.full_name,
        email: created.email,
        phone: created.phone
      }
    });
  } catch (err) {
    console.error("[ADMIN_CREATE_CUSTOMER] error", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
