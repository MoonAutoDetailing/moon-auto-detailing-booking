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

function cleanBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-crm-notes: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    if (req.method === "GET") {
      const customerId = clean(req.query.customer_id);
      if (!customerId) {
        return res.status(400).json({ ok: false, error: "Missing customer_id" });
      }

      const { data: notes, error } = await supabase
        .from("crm_notes")
        .select("*")
        .eq("customer_id", customerId)
        .order("pinned", { ascending: false })
        .order("created_at", { ascending: false });

      if (error) throw error;
      return res.status(200).json({ ok: true, notes: notes || [] });
    }

    const body = req.body || {};
    const customerId = clean(body.customer_id);
    const note = clean(body.note);
    if (!customerId) {
      return res.status(400).json({ ok: false, error: "Missing customer_id" });
    }
    if (!note) {
      return res.status(400).json({ ok: false, error: "Missing note" });
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

    const { data: created, error } = await supabase
      .from("crm_notes")
      .insert([{
        customer_id: customerId,
        note,
        pinned: cleanBoolean(body.pinned),
        created_by: clean(body.created_by) || "admin"
      }])
      .select("*")
      .single();

    if (error) throw error;
    return res.status(200).json({ ok: true, note: created });
  } catch (err) {
    console.error("admin-crm-notes error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
