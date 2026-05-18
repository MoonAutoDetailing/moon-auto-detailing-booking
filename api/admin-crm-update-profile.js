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

function cleanBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
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
    console.error("admin-crm-update-profile: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const customerId = clean(body.customer_id);
    if (!customerId) {
      return res.status(400).json({ ok: false, error: "Missing customer_id" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customerId)
      .maybeSingle();

    if (customerError) throw customerError;
    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    const { data: existingProfile, error: existingProfileError } = await supabase
      .from("crm_profiles")
      .select("*")
      .eq("customer_id", customerId)
      .maybeSingle();

    if (existingProfileError) throw existingProfileError;

    const profilePayload = {
      customer_id: customerId,
      company_name: existingProfile?.company_name ?? null,
      customer_type: existingProfile?.customer_type ?? "residential",
      lifecycle_stage: existingProfile?.lifecycle_stage ?? "lead",
      lead_source: existingProfile?.lead_source ?? null,
      preferred_contact_method: existingProfile?.preferred_contact_method ?? "sms",
      status: existingProfile?.status ?? "active",
      priority: existingProfile?.priority ?? "medium",
      do_not_contact: existingProfile?.do_not_contact ?? false,
      crm_notes: existingProfile?.crm_notes ?? null,
      updated_at: new Date().toISOString()
    };

    const textFields = [
      "company_name",
      "customer_type",
      "lifecycle_stage",
      "lead_source",
      "preferred_contact_method",
      "status",
      "priority",
      "crm_notes"
    ];

    for (const field of textFields) {
      if (hasOwn(body, field)) {
        profilePayload[field] = clean(body[field]);
      }
    }

    if (hasOwn(body, "do_not_contact")) {
      profilePayload.do_not_contact = cleanBoolean(body.do_not_contact);
    }

    const { data: profile, error: profileError } = await supabase
      .from("crm_profiles")
      .upsert([profilePayload], { onConflict: "customer_id" })
      .select("*")
      .single();

    if (profileError) throw profileError;

    return res.status(200).json({
      ok: true,
      profile
    });
  } catch (err) {
    console.error("admin-crm-update-profile error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
