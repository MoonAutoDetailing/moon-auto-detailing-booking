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
    console.error("admin-crm-create-lead: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const firstName = clean(body.first_name);
    const lastName = clean(body.last_name);
    const fullName = clean(body.full_name) || (firstName && lastName ? `${firstName} ${lastName}` : null);
    const email = clean(body.email)?.toLowerCase() || null;
    const phone = clean(body.phone);

    if (!fullName) {
      return res.status(400).json({ ok: false, error: "full_name or first_name and last_name are required" });
    }
    if (!phone && !email) {
      return res.status(400).json({ ok: false, error: "phone or email is required" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const customerPayload = {
      id: crypto.randomUUID(),
      full_name: fullName,
      email,
      phone,
      address: clean(body.address)
    };

    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .insert([customerPayload])
      .select("id, full_name, email, phone, address")
      .single();

    if (customerError) throw customerError;

    const priority = clean(body.priority) || "medium";
    const profilePayload = {
      customer_id: customer.id,
      company_name: clean(body.company_name),
      customer_type: clean(body.customer_type) || "residential",
      lifecycle_stage: clean(body.lifecycle_stage) || "lead",
      lead_source: clean(body.lead_source),
      preferred_contact_method: clean(body.preferred_contact_method) || "sms",
      status: clean(body.status) || "active",
      priority,
      crm_notes: clean(body.crm_notes)
    };

    const { data: profile, error: profileError } = await supabase
      .from("crm_profiles")
      .insert([profilePayload])
      .select("*")
      .single();

    if (profileError) throw profileError;

    let followUpTask = null;
    const nextFollowUpAt = clean(body.next_follow_up_at);
    if (nextFollowUpAt) {
      const taskPayload = {
        customer_id: customer.id,
        task_type: "lead_follow_up",
        due_at: nextFollowUpAt,
        priority,
        status: "open",
        notes: clean(body.follow_up_notes) || clean(body.crm_notes)
      };

      const { data: task, error: taskError } = await supabase
        .from("crm_follow_up_tasks")
        .insert([taskPayload])
        .select("*")
        .single();

      if (taskError) throw taskError;
      followUpTask = task;
    }

    return res.status(200).json({
      ok: true,
      customer_id: customer.id,
      customer,
      profile,
      follow_up_task: followUpTask
    });
  } catch (err) {
    console.error("admin-crm-create-lead error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
