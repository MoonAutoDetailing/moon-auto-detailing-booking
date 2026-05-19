import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const RULE = {
  LEAD_FOLLOWUP: "lead_created_24h_followup",
  REVIEW_REQUEST: "completed_booking_review_request",
  MAINTENANCE_REMINDER: "completed_booking_maintenance_30d"
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

    console.log("[CRM_AUTOMATION] created", {
      lead_followups: leadFollowups,
      review_requests: reviewRequests,
      maintenance_reminders: maintenanceReminders
    });

    return res.status(200).json({
      ok: true,
      created: {
        lead_followups: leadFollowups,
        review_requests: reviewRequests,
        maintenance_reminders: maintenanceReminders
      }
    });
  } catch (err) {
    console.error("cron-crm-automation error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
}
