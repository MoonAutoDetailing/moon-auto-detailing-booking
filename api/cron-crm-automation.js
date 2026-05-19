import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const RULE = {
  LEAD_FOLLOWUP: "lead_created_24h_followup",
  REVIEW_REQUEST: "completed_booking_review_request",
  MAINTENANCE_REMINDER: "completed_booking_maintenance_30d",
  INACTIVE_90D: "inactive_customer_90d",
  INACTIVE_180D: "inactive_customer_180d"
};

const MAX_PER_RULE = 50;
const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

async function loadExistingSourceIds(supabase, ruleKey, sourceType) {
  const { data, error } = await supabase
    .from("crm_automation_runs")
    .select("source_id")
    .eq("rule_key", ruleKey)
    .eq("source_type", sourceType);

  if (error) throw error;
  return new Set((data || []).map((row) => row.source_id));
}

async function createTaskAndRun(supabase, {
  ruleKey,
  sourceType,
  sourceId,
  customerId,
  taskPayload
}) {
  const { data: task, error: taskError } = await supabase
    .from("crm_follow_up_tasks")
    .insert([taskPayload])
    .select("id")
    .single();

  if (taskError) throw taskError;

  const { error: runError } = await supabase
    .from("crm_automation_runs")
    .insert([{
      rule_key: ruleKey,
      source_type: sourceType,
      source_id: sourceId,
      customer_id: customerId,
      task_id: task.id
    }]);

  if (runError) {
    if (runError.code === "23505") return null;
    throw runError;
  }

  return task;
}

async function runLeadFollowupRule(supabase, cutoffIso, nowIso) {
  const existing = await loadExistingSourceIds(supabase, RULE.LEAD_FOLLOWUP, "customer");

  const { data: profiles, error: profileError } = await supabase
    .from("crm_profiles")
    .select("customer_id")
    .eq("lifecycle_stage", "lead");

  if (profileError) throw profileError;

  const customerIds = [...new Set((profiles || []).map((row) => row.customer_id).filter(Boolean))];
  if (customerIds.length === 0) return 0;

  const { data: customers, error: customerError } = await supabase
    .from("customers")
    .select("id, created_at")
    .in("id", customerIds)
    .lte("created_at", cutoffIso)
    .order("created_at", { ascending: true });

  if (customerError) throw customerError;

  let created = 0;
  for (const customer of customers || []) {
    if (created >= MAX_PER_RULE) break;
    if (!customer.id || existing.has(customer.id)) continue;

    const task = await createTaskAndRun(supabase, {
      ruleKey: RULE.LEAD_FOLLOWUP,
      sourceType: "customer",
      sourceId: customer.id,
      customerId: customer.id,
      taskPayload: {
        customer_id: customer.id,
        task_type: "lead_follow_up",
        due_at: nowIso,
        priority: "high",
        status: "open",
        notes: "Automated task: follow up with new lead."
      }
    });

    if (task) {
      existing.add(customer.id);
      created += 1;
    }
  }

  return created;
}

async function runCompletedBookingRule(supabase, {
  ruleKey,
  cutoffIso,
  nowIso,
  taskType,
  priority,
  notes
}) {
  const existing = await loadExistingSourceIds(supabase, ruleKey, "booking");

  const { data: bookings, error: bookingError } = await supabase
    .from("bookings")
    .select("id, customer_id, scheduled_start")
    .eq("status", "completed")
    .not("customer_id", "is", null)
    .lte("scheduled_start", cutoffIso)
    .order("scheduled_start", { ascending: true });

  if (bookingError) throw bookingError;

  let created = 0;
  for (const booking of bookings || []) {
    if (created >= MAX_PER_RULE) break;
    if (!booking.id || !booking.customer_id || existing.has(booking.id)) continue;

    const task = await createTaskAndRun(supabase, {
      ruleKey,
      sourceType: "booking",
      sourceId: booking.id,
      customerId: booking.customer_id,
      taskPayload: {
        customer_id: booking.customer_id,
        booking_id: booking.id,
        task_type: taskType,
        due_at: nowIso,
        priority,
        status: "open",
        notes
      }
    });

    if (task) {
      existing.add(booking.id);
      created += 1;
    }
  }

  return created;
}

async function buildLastCompletedByCustomer(supabase) {
  const byCustomer = new Map();
  let from = 0;
  const pageSize = 1000;

  while (from < 20000) {
    const { data, error } = await supabase
      .from("bookings")
      .select("customer_id, scheduled_start")
      .eq("status", "completed")
      .not("customer_id", "is", null)
      .order("scheduled_start", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (!row.customer_id || byCustomer.has(row.customer_id)) continue;
      byCustomer.set(row.customer_id, row.scheduled_start);
    }

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return byCustomer;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function shouldSkipInactiveProfile(profile) {
  if (!profile) return false;
  if (profile.do_not_contact) return true;
  const status = normalizeStatus(profile.status);
  return status === "inactive" || status === "do_not_contact";
}

async function upsertCrmProfileStatus(supabase, customerId, status, nowIso, existingProfile) {
  const payload = {
    customer_id: customerId,
    company_name: existingProfile?.company_name ?? null,
    customer_type: existingProfile?.customer_type ?? "residential",
    lifecycle_stage: existingProfile?.lifecycle_stage ?? "customer",
    lead_source: existingProfile?.lead_source ?? null,
    preferred_contact_method: existingProfile?.preferred_contact_method ?? "sms",
    status,
    priority: existingProfile?.priority ?? "medium",
    do_not_contact: existingProfile?.do_not_contact ?? false,
    crm_notes: existingProfile?.crm_notes ?? null,
    updated_at: nowIso
  };

  const { error } = await supabase
    .from("crm_profiles")
    .upsert([payload], { onConflict: "customer_id" });

  if (error) throw error;
}

async function runInactiveCustomerRule(supabase, {
  ruleKey,
  cutoffIso,
  nowIso,
  profileStatus,
  taskType,
  priority,
  notes
}) {
  const lastByCustomer = await buildLastCompletedByCustomer(supabase);
  const existing = await loadExistingSourceIds(supabase, ruleKey, "customer");

  const candidates = [];
  for (const [customerId, lastService] of lastByCustomer) {
    if (!customerId || !lastService || existing.has(customerId)) continue;
    if (lastService > cutoffIso) continue;
    candidates.push({ customerId, lastService });
  }

  candidates.sort((a, b) => String(a.lastService).localeCompare(String(b.lastService)));
  if (candidates.length === 0) return 0;

  const prefetchIds = candidates.slice(0, 500).map((row) => row.customerId);
  const { data: profiles, error: profileError } = await supabase
    .from("crm_profiles")
    .select("customer_id, status, do_not_contact, company_name, customer_type, lifecycle_stage, lead_source, preferred_contact_method, priority, crm_notes")
    .in("customer_id", prefetchIds);

  if (profileError) throw profileError;

  const profileByCustomer = new Map((profiles || []).map((row) => [row.customer_id, row]));

  let created = 0;
  for (const { customerId } of candidates) {
    if (created >= MAX_PER_RULE) break;

    const profile = profileByCustomer.get(customerId);
    if (shouldSkipInactiveProfile(profile)) continue;

    await upsertCrmProfileStatus(supabase, customerId, profileStatus, nowIso, profile);

    const task = await createTaskAndRun(supabase, {
      ruleKey,
      sourceType: "customer",
      sourceId: customerId,
      customerId,
      taskPayload: {
        customer_id: customerId,
        task_type: taskType,
        due_at: nowIso,
        priority,
        status: "open",
        notes
      }
    });

    if (task) {
      existing.add(customerId);
      created += 1;
    }
  }

  return created;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization;
  const cronHeader = req.headers["x-vercel-cron"];
  const validBearer = authHeader && authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const validVercelCron = cronHeader === "1";

  if (!validBearer && !validVercelCron) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const nowIso = new Date().toISOString();
    const cutoff24h = new Date(Date.now() - 24 * MS_HOUR).toISOString();
    const cutoff30d = new Date(Date.now() - 30 * MS_DAY).toISOString();
    const cutoff90d = new Date(Date.now() - 90 * MS_DAY).toISOString();
    const cutoff180d = new Date(Date.now() - 180 * MS_DAY).toISOString();

    const leadFollowups = await runLeadFollowupRule(supabase, cutoff24h, nowIso);
    const reviewRequests = await runCompletedBookingRule(supabase, {
      ruleKey: RULE.REVIEW_REQUEST,
      cutoffIso: cutoff24h,
      nowIso,
      taskType: "review_request",
      priority: "medium",
      notes: "Automated task: ask customer for a review."
    });
    const maintenanceReminders = await runCompletedBookingRule(supabase, {
      ruleKey: RULE.MAINTENANCE_REMINDER,
      cutoffIso: cutoff30d,
      nowIso,
      taskType: "maintenance_reminder",
      priority: "medium",
      notes: "Automated task: check in for maintenance detail or wash."
    });
    const coolingCustomers = await runInactiveCustomerRule(supabase, {
      ruleKey: RULE.INACTIVE_90D,
      cutoffIso: cutoff90d,
      nowIso,
      profileStatus: "cooling",
      taskType: "reactivation_follow_up",
      priority: "medium",
      notes: "Automated task: inactive customer follow-up (90+ days)."
    });
    const inactiveCustomers = await runInactiveCustomerRule(supabase, {
      ruleKey: RULE.INACTIVE_180D,
      cutoffIso: cutoff180d,
      nowIso,
      profileStatus: "inactive",
      taskType: "winback_follow_up",
      priority: "high",
      notes: "Automated task: win back inactive customer (180+ days)."
    });

    console.log("[CRM_AUTOMATION] created", {
      lead_followups: leadFollowups,
      review_requests: reviewRequests,
      maintenance_reminders: maintenanceReminders,
      cooling_customers: coolingCustomers,
      inactive_customers: inactiveCustomers
    });

    return res.status(200).json({
      ok: true,
      created: {
        lead_followups: leadFollowups,
        review_requests: reviewRequests,
        maintenance_reminders: maintenanceReminders,
        cooling_customers: coolingCustomers,
        inactive_customers: inactiveCustomers
      }
    });
  } catch (err) {
    console.error("cron-crm-automation error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
