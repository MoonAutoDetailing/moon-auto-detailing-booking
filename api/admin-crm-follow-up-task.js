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

async function verifyCustomer(supabase, customerId) {
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function verifyBooking(supabase, bookingId) {
  const { data, error } = await supabase
    .from("bookings")
    .select("id")
    .eq("id", bookingId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function loadTask(supabase, taskId) {
  const { data, error } = await supabase
    .from("crm_follow_up_tasks")
    .select("id")
    .eq("id", taskId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function updateTask(supabase, taskId, payload) {
  const { data, error } = await supabase
    .from("crm_follow_up_tasks")
    .update(payload)
    .eq("id", taskId)
    .select("*")
    .single();

  if (error) throw error;
  return data;
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
    console.error("admin-crm-follow-up-task: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const action = clean(body.action);
    const taskId = clean(body.task_id);
    const customerId = clean(body.customer_id);
    const bookingId = clean(body.booking_id);
    const now = new Date().toISOString();
    const supportedActions = ["create", "update", "complete", "snooze", "dismiss"];

    if (!supportedActions.includes(action)) {
      return res.status(400).json({ ok: false, error: "Missing or invalid action" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    if (action === "create") {
      const taskType = clean(body.task_type);
      const dueAt = clean(body.due_at);

      if (!customerId) {
        return res.status(400).json({ ok: false, error: "Missing customer_id" });
      }
      if (!taskType) {
        return res.status(400).json({ ok: false, error: "Missing task_type" });
      }
      if (!dueAt) {
        return res.status(400).json({ ok: false, error: "Missing due_at" });
      }

      const customer = await verifyCustomer(supabase, customerId);
      if (!customer) {
        return res.status(404).json({ ok: false, error: "Customer not found" });
      }

      if (bookingId) {
        const booking = await verifyBooking(supabase, bookingId);
        if (!booking) {
          return res.status(404).json({ ok: false, error: "Booking not found" });
        }
      }

      const { data: task, error } = await supabase
        .from("crm_follow_up_tasks")
        .insert([{
          customer_id: customerId,
          booking_id: bookingId,
          task_type: taskType,
          due_at: dueAt,
          priority: clean(body.priority) || "medium",
          status: "open",
          notes: clean(body.notes)
        }])
        .select("*")
        .single();

      if (error) throw error;
      return res.status(200).json({ ok: true, task });
    }

    if (!taskId) {
      return res.status(400).json({ ok: false, error: "Missing task_id" });
    }

    const existingTask = await loadTask(supabase, taskId);
    if (!existingTask) {
      return res.status(404).json({ ok: false, error: "Task not found" });
    }

    if (action === "update") {
      const updatePayload = {
        updated_at: now
      };
      const allowedFields = ["task_type", "due_at", "priority", "status", "notes"];

      for (const field of allowedFields) {
        if (hasOwn(body, field)) {
          updatePayload[field] = clean(body[field]);
        }
      }

      const task = await updateTask(supabase, taskId, updatePayload);
      return res.status(200).json({ ok: true, task });
    }

    if (action === "complete") {
      const task = await updateTask(supabase, taskId, {
        status: "completed",
        completed_at: now,
        updated_at: now
      });
      return res.status(200).json({ ok: true, task });
    }

    if (action === "snooze") {
      const snoozeUntil = clean(body.snooze_until);
      if (!snoozeUntil) {
        return res.status(400).json({ ok: false, error: "Missing snooze_until" });
      }

      const task = await updateTask(supabase, taskId, {
        due_at: snoozeUntil,
        status: "snoozed",
        updated_at: now
      });
      return res.status(200).json({ ok: true, task });
    }

    const task = await updateTask(supabase, taskId, {
      status: "dismissed",
      updated_at: now
    });
    return res.status(200).json({ ok: true, task });
  } catch (err) {
    console.error("admin-crm-follow-up-task error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
