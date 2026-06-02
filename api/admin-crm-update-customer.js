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

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const PLACEHOLDER_EMAILS = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "no email",
  "noemail",
  "-",
  "—"
]);

function normalizeCustomerEmail(value) {
  const text = clean(value);
  if (!text) return null;
  const lower = text.toLowerCase();
  if (PLACEHOLDER_EMAILS.has(lower)) return null;
  return lower;
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
    console.error("admin-crm-update-customer: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const customerId = clean(body.customer_id);
    if (!customerId) {
      return res.status(400).json({ ok: false, error: "Missing customer_id" });
    }

    const payload = {};
    if (hasOwn(body, "full_name")) {
      const fullName = clean(body.full_name);
      if (!fullName) {
        return res.status(400).json({ ok: false, error: "full_name cannot be empty" });
      }
      payload.full_name = fullName;
    }
    if (hasOwn(body, "phone")) payload.phone = clean(body.phone);
    if (hasOwn(body, "email")) payload.email = normalizeCustomerEmail(body.email);
    if (hasOwn(body, "address")) payload.address = clean(body.address);

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ ok: false, error: "No customer fields to update" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: existing, error: existingError } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customerId)
      .maybeSingle();

    if (existingError) throw existingError;
    if (!existing) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    const { data: customer, error: updateError } = await supabase
      .from("customers")
      .update(payload)
      .eq("id", customerId)
      .select("id, full_name, email, phone, address, created_at")
      .single();

    if (updateError) throw updateError;

    return res.status(200).json({
      ok: true,
      customer
    });
  } catch (err) {
    console.error("admin-crm-update-customer error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
