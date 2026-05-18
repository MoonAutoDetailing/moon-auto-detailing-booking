import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function escapeIlike(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function parseLimit(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 200);
}

function parseOffset(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-crm-customers: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const q = String(req.query.q || "").trim();
    const lifecycleStage = String(req.query.lifecycle_stage || "").trim();
    const crmStatus = String(req.query.crm_status || "").trim();
    const priority = String(req.query.priority || "").trim();
    const due = String(req.query.due || "").trim();
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    let query = supabase
      .from("crm_customer_summary")
      .select("*", { count: "exact" });

    if (q) {
      const safe = escapeIlike(q);
      query = query.or(
        `full_name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%,address.ilike.%${safe}%,company_name.ilike.%${safe}%,crm_notes.ilike.%${safe}%`
      );
    }
    if (lifecycleStage) {
      query = query.eq("lifecycle_stage", lifecycleStage);
    }
    if (crmStatus) {
      query = query.eq("crm_status", crmStatus);
    }
    if (priority) {
      query = query.eq("crm_priority", priority);
    }
    if (due === "today") {
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);
      query = query.lte("next_follow_up_at", endOfToday.toISOString());
    } else if (due === "overdue") {
      query = query.lt("next_follow_up_at", new Date().toISOString());
    } else if (due === "open") {
      query = query.not("next_follow_up_at", "is", null);
    }

    const { data, error, count } = await query
      .order("next_follow_up_at", { ascending: true, nullsFirst: false })
      .order("total_revenue", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return res.status(200).json({
      ok: true,
      customers: data || [],
      count: count || 0
    });
  } catch (err) {
    console.error("admin-crm-customers error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
