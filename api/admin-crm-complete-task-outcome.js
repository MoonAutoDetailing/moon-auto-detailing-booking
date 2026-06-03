import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { syncCrmProfileStage } from "./_crmWorkflow.js";

const MS_DAY = 24 * 60 * 60 * 1000;
const OPEN_TASK_STATUSES = ["open", "snoozed", "pending_response"];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function dueInDays(days) {
  return new Date(Date.now() + days * MS_DAY).toISOString();
}

async function addNote(supabase, customerId, note, summary) {
  if (!note) return null;
  const { data, error } = await supabase
    .from("crm_notes")
    .insert([{ customer_id: customerId, note, pinned: false, created_by: "admin" }])
    .select("*")
    .single();

  if (error) throw error;
  summary.notes.push(note);
  return data;
}

async function createTask(supabase, { customerId, taskType, dueAt, priority, notes }, summary) {
  const { data, error } = await supabase
    .from("crm_follow_up_tasks")
    .insert([{
      customer_id: customerId,
      task_type: taskType,
      due_at: dueAt,
      priority: priority || "high",
      status: "open",
      notes: notes || null
    }])
    .select("*")
    .single();

  if (error) throw error;
  summary.created_tasks.push(data);
  return data;
}

async function updateProfile(supabase, customerId, payload, summary) {
  if (!payload) return null;
  const profile = await syncCrmProfileStage(supabase, customerId, payload);
  if (profile) summary.profile = profile;
  return profile;
}

async function hasActiveBooking(supabase, customerId) {
  const { data, error } = await supabase
    .from("bookings")
    .select("id")
    .eq("customer_id", customerId)
    .in("status", ["pending", "booked", "confirmed"])
    .limit(1);

  if (error) throw error;
  return Boolean(data?.length);
}

async function closeRelatedReviewTasks(supabase, customerId, currentTaskId, summary) {
  const { data: tasks, error: loadError } = await supabase
    .from("crm_follow_up_tasks")
    .select("id, task_type, notes")
    .eq("customer_id", customerId)
    .in("status", OPEN_TASK_STATUSES);

  if (loadError) throw loadError;

  const ids = (tasks || [])
    .filter((task) => {
      if (String(task.id) === String(currentTaskId)) return false;
      const type = normalize(task.task_type);
      if (type === "review_request") return true;
      return type === "check_response" && normalize(task.notes).includes("review");
    })
    .map((task) => task.id);

  if (!ids.length) return [];

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("crm_follow_up_tasks")
    .update({ status: "completed", completed_at: now, updated_at: now })
    .in("id", ids)
    .select("id, task_type, status");

  if (error) throw error;
  summary.closed_tasks.push(...(data || []));
  return data || [];
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
    console.error("admin-crm-complete-task-outcome: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const taskId = clean(body.task_id);
    const customerIdFromBody = clean(body.customer_id);
    const outcome = clean(body.outcome) || "completed_only";
    const now = new Date().toISOString();

    if (!taskId) {
      return res.status(400).json({ ok: false, error: "Missing task_id" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: task, error: taskError } = await supabase
      .from("crm_follow_up_tasks")
      .select("*")
      .eq("id", taskId)
      .maybeSingle();

    if (taskError) throw taskError;
    if (!task) {
      return res.status(404).json({ ok: false, error: "Task not found" });
    }

    const customerId = task.customer_id || customerIdFromBody;
    if (!customerId) {
      return res.status(400).json({ ok: false, error: "Missing customer_id" });
    }
    if (customerIdFromBody && String(customerIdFromBody) !== String(customerId)) {
      return res.status(400).json({ ok: false, error: "Task/customer mismatch" });
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

    const summary = {
      task_completed: null,
      notes: [],
      created_tasks: [],
      closed_tasks: [],
      profile: null
    };

    const { data: completedTask, error: completeError } = await supabase
      .from("crm_follow_up_tasks")
      .update({ status: "completed", completed_at: now, updated_at: now })
      .eq("id", taskId)
      .select("*")
      .single();

    if (completeError) throw completeError;
    summary.task_completed = completedTask;

    const priority = task.priority || "high";

    if (outcome === "review_received") {
      await addNote(supabase, customerId, "Review received.", summary);
      await closeRelatedReviewTasks(supabase, customerId, taskId, summary);
    } else if (outcome === "review_no_response") {
      await createTask(supabase, {
        customerId,
        taskType: "check_response",
        dueAt: dueInDays(3),
        priority,
        notes: "Check whether customer responded to review request."
      }, summary);
    } else if (outcome === "review_declined") {
      await addNote(supabase, customerId, "Review request completed; review not received.", summary);
    } else if (outcome === "maintenance_interested") {
      await addNote(supabase, customerId, "Customer responded to maintenance reminder.", summary);
      if (!(await hasActiveBooking(supabase, customerId))) {
        await createTask(supabase, {
          customerId,
          taskType: "general_follow_up",
          dueAt: dueInDays(3),
          priority,
          notes: "Follow up on maintenance reminder interest."
        }, summary);
      }
    } else if (outcome === "maintenance_waiting") {
      await createTask(supabase, {
        customerId,
        taskType: "check_response",
        dueAt: dueInDays(3),
        priority,
        notes: "No response to maintenance reminder yet; check again in 3 days."
      }, summary);
    } else if (outcome === "maintenance_not_interested") {
      await addNote(supabase, customerId, "Maintenance reminder completed; customer not interested right now.", summary);
    } else if (outcome === "maintenance_booked") {
      await addNote(supabase, customerId, "Customer interested/booked from maintenance reminder. Confirm booking separately if needed.", summary);
      await updateProfile(supabase, customerId, { lifecycle_stage: "booked", status: "active" }, summary);
    } else if (outcome === "response_yes") {
      await addNote(supabase, customerId, "Customer responded.", summary);
    } else if (outcome === "response_none") {
      await createTask(supabase, {
        customerId,
        taskType: "check_response",
        dueAt: dueInDays(3),
        priority,
        notes: "Still waiting for response; check again in 3 days."
      }, summary);
    } else if (outcome === "response_booked") {
      await updateProfile(supabase, customerId, { lifecycle_stage: "booked", status: "active" }, summary);
    } else if (outcome === "response_declined") {
      await addNote(supabase, customerId, "Customer declined / not interested.", summary);
      await updateProfile(supabase, customerId, { status: "cooling" }, summary);
      await updateProfile(supabase, customerId, { lifecycle_stage: "lost", status: "cooling" }, summary);
    } else if (outcome === "cancel_reschedule_yes") {
      await addNote(supabase, customerId, "Cancellation follow-up completed; customer wants to reschedule.", summary);
    } else if (outcome === "cancel_reschedule_no") {
      await addNote(supabase, customerId, "Cancellation follow-up completed; not rescheduling now.", summary);
    } else if (outcome === "cancel_no_response") {
      await createTask(supabase, {
        customerId,
        taskType: "check_response",
        dueAt: dueInDays(3),
        priority,
        notes: "No response to cancellation follow-up; check again in 3 days."
      }, summary);
    } else if (outcome === "followup_interested") {
      await addNote(supabase, customerId, "Customer responded to follow-up.", summary);
      await updateProfile(supabase, customerId, { lifecycle_stage: "contacted" }, summary);
    } else if (outcome === "followup_waiting") {
      await createTask(supabase, {
        customerId,
        taskType: "check_response",
        dueAt: dueInDays(3),
        priority,
        notes: "Waiting for response to follow-up; check again in 3 days."
      }, summary);
    } else if (outcome === "followup_booked") {
      await updateProfile(supabase, customerId, { lifecycle_stage: "booked", status: "active" }, summary);
    } else if (outcome === "followup_lost") {
      await updateProfile(supabase, customerId, { status: "cooling" }, summary);
      await updateProfile(supabase, customerId, { lifecycle_stage: "lost", status: "cooling" }, summary);
    }

    return res.status(200).json({ ok: true, summary });
  } catch (err) {
    console.error("admin-crm-complete-task-outcome error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
