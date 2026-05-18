import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function sortFollowUpTasks(tasks) {
  return [...(tasks || [])].sort((a, b) => {
    const aOpen = a.status === "open" ? 0 : 1;
    const bOpen = b.status === "open" ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    if (!a.due_at && !b.due_at) return 0;
    if (!a.due_at) return 1;
    if (!b.due_at) return -1;
    return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
  });
}

async function loadBookings(supabase, customerId) {
  const joined = await supabase
    .from("bookings")
    .select(`
      *,
      service_variants:service_variant_id (
        id,
        services:service_id (
          id,
          category,
          level
        )
      )
    `)
    .eq("customer_id", customerId)
    .order("scheduled_start", { ascending: false });

  if (!joined.error) return joined.data || [];

  const plain = await supabase
    .from("bookings")
    .select("*")
    .eq("customer_id", customerId)
    .order("scheduled_start", { ascending: false });

  if (plain.error) throw plain.error;
  return plain.data || [];
}

async function loadTags(supabase, customerId) {
  const joined = await supabase
    .from("crm_customer_tags")
    .select("*, crm_tags (*)")
    .eq("customer_id", customerId);

  if (!joined.error) {
    return (joined.data || []).map((row) => row.crm_tags || row).filter(Boolean);
  }

  const assignments = await supabase
    .from("crm_customer_tags")
    .select("*")
    .eq("customer_id", customerId);

  if (assignments.error) throw assignments.error;

  const tagIds = [...new Set((assignments.data || []).map((row) => row.tag_id).filter(Boolean))];
  if (tagIds.length === 0) return [];

  const tags = await supabase
    .from("crm_tags")
    .select("*")
    .in("id", tagIds);

  if (tags.error) throw tags.error;
  return tags.data || [];
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
    console.error("admin-crm-customer-detail: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const customerId = String(req.query.customer_id || "").trim();
    if (!customerId) {
      return res.status(400).json({ ok: false, error: "Missing customer_id" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: customer, error: customerError } = await supabase
      .from("crm_customer_summary")
      .select("*")
      .eq("customer_id", customerId)
      .maybeSingle();

    if (customerError) throw customerError;
    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    const [
      profileResult,
      vehiclesResult,
      bookings,
      outreachLogsResult,
      followUpTasksResult,
      tags
    ] = await Promise.all([
      supabase
        .from("crm_profiles")
        .select("*")
        .eq("customer_id", customerId)
        .maybeSingle(),
      supabase
        .from("vehicles")
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false }),
      loadBookings(supabase, customerId),
      supabase
        .from("crm_outreach_logs")
        .select("*")
        .eq("customer_id", customerId)
        .order("contacted_at", { ascending: false }),
      supabase
        .from("crm_follow_up_tasks")
        .select("*")
        .eq("customer_id", customerId)
        .order("due_at", { ascending: true }),
      loadTags(supabase, customerId)
    ]);

    if (profileResult.error) throw profileResult.error;
    if (vehiclesResult.error) throw vehiclesResult.error;
    if (outreachLogsResult.error) throw outreachLogsResult.error;
    if (followUpTasksResult.error) throw followUpTasksResult.error;

    return res.status(200).json({
      ok: true,
      customer,
      profile: profileResult.data || null,
      vehicles: vehiclesResult.data || [],
      bookings,
      outreach_logs: outreachLogsResult.data || [],
      follow_up_tasks: sortFollowUpTasks(followUpTasksResult.data),
      tags
    });
  } catch (err) {
    console.error("admin-crm-customer-detail error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
