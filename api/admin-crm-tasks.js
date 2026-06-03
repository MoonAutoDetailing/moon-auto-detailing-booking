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

function parseLimit(value, fallback = 100) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 500);
}

function parseOffset(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfTomorrow() {
  const date = startOfToday();
  date.setDate(date.getDate() + 1);
  return date;
}

const COMPLETED_BOOKING_STATUSES = ["completed", "complete", "done"];

function isOpenTask(status) {
  const value = String(clean(status) || "").toLowerCase();
  return value === "open" || value === "snoozed" || value === "pending_response";
}

function taskBucket(task) {
  const status = String(clean(task.status) || "open").toLowerCase();
  if (status === "completed") return "completed";
  if (!isOpenTask(status)) return null;

  const due = task.due_at ? new Date(task.due_at) : null;
  if (!due || Number.isNaN(due.getTime())) return "upcoming";

  const today = startOfToday();
  const tomorrow = startOfTomorrow();
  if (due.getTime() < today.getTime()) return "overdue";
  if (due.getTime() < tomorrow.getTime()) return "today";
  return "upcoming";
}

function toTaskRow(task, customer) {
  return {
    task_id: task.id,
    customer_id: task.customer_id,
    booking_id: task.booking_id,
    task_type: task.task_type,
    due_at: task.due_at,
    priority: task.priority,
    status: task.status,
    notes: task.notes,
    completed_at: task.completed_at,
    full_name: customer?.full_name || null,
    phone: customer?.phone || null,
    email: customer?.email || null,
    address: customer?.address || null,
    crm_status: customer?.crm_status || customer?.status || null,
    lifecycle_stage: customer?.lifecycle_stage || null,
    total_revenue: Number(customer?.total_revenue) || 0,
    last_service_date: customer?.last_service_date || null
  };
}

async function loadCompletedBookingSummary(supabase, customerIds) {
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const { data, error } = await supabase
    .from("bookings")
    .select("customer_id, total_price, scheduled_start, status")
    .in("customer_id", ids)
    .in("status", COMPLETED_BOOKING_STATUSES);

  if (error) throw error;

  const byCustomer = new Map();
  for (const booking of data || []) {
    const customerId = booking.customer_id;
    if (!customerId) continue;
    const current = byCustomer.get(customerId) || {
      total_revenue: 0,
      completed_bookings: 0,
      last_service_date: null
    };
    current.total_revenue += Number(booking.total_price) || 0;
    current.completed_bookings += 1;
    const serviceDate = booking.completed_at || booking.scheduled_start;
    if (serviceDate && (!current.last_service_date || new Date(serviceDate).getTime() > new Date(current.last_service_date).getTime())) {
      current.last_service_date = serviceDate;
    }
    byCustomer.set(customerId, current);
  }
  return byCustomer;
}

function applyBookingSummary(row, bookingSummary) {
  const customerId = row.customer_id || row.id;
  const summary = bookingSummary.get(customerId);
  return {
    ...row,
    total_revenue: summary ? Math.round(summary.total_revenue * 100) / 100 : 0,
    completed_bookings: summary ? summary.completed_bookings : 0,
    last_service_date: summary?.last_service_date || row.last_service_date || null
  };
}

function sortBucketRows(bucket, rows) {
  const copy = [...rows];
  if (bucket === "completed") {
    return copy.sort((a, b) => new Date(b.completed_at || 0).getTime() - new Date(a.completed_at || 0).getTime());
  }
  return copy.sort((a, b) => new Date(a.due_at || 8640000000000000).getTime() - new Date(b.due_at || 8640000000000000).getTime());
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
    console.error("admin-crm-tasks: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const status = clean(req.query.status);
    const requestedBucket = clean(req.query.bucket);
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const buckets = ["overdue", "today", "upcoming", "completed"];

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    let query = supabase
      .from("crm_follow_up_tasks")
      .select("id, customer_id, booking_id, task_type, due_at, priority, status, notes, completed_at, created_at, updated_at")
      .in("status", status ? [status] : ["open", "snoozed", "pending_response", "completed"])
      .limit(5000);

    const { data: rawTasks, error: tasksError } = await query;
    if (tasksError) throw tasksError;

    const customerIds = [...new Set((rawTasks || []).map((task) => task.customer_id).filter(Boolean))];
    let summaries = [];
    if (customerIds.length) {
      const { data, error } = await supabase
        .from("crm_customer_summary")
        .select("customer_id, id, full_name, phone, email, address, crm_status, status, lifecycle_stage, total_revenue, last_service_date")
        .in("customer_id", customerIds);
      if (error) throw error;
      summaries = data || [];
    }

    const summaryByCustomerId = new Map();
    summaries.forEach((row) => {
      summaryByCustomerId.set(row.customer_id || row.id, row);
    });

    const missingCustomerIds = customerIds.filter((id) => !summaryByCustomerId.has(id));
    if (missingCustomerIds.length) {
      const { data, error } = await supabase
        .from("customers")
        .select("id, full_name, phone, email, address")
        .in("id", missingCustomerIds);
      if (error) throw error;
      (data || []).forEach((row) => {
        summaryByCustomerId.set(row.id, {
          customer_id: row.id,
          ...row,
          total_revenue: 0,
          completed_bookings: 0
        });
      });
    }

    const bookingSummary = await loadCompletedBookingSummary(supabase, customerIds);
    summaryByCustomerId.forEach((row, id) => {
      summaryByCustomerId.set(id, applyBookingSummary(row, bookingSummary));
    });

    const grouped = {
      overdue: [],
      today: [],
      upcoming: [],
      completed: []
    };

    (rawTasks || []).forEach((task) => {
      const bucket = taskBucket(task);
      if (!bucket || !buckets.includes(bucket)) return;
      const customer = summaryByCustomerId.get(task.customer_id);
      grouped[bucket].push(toTaskRow(task, customer));
    });

    const counts = {
      overdue: grouped.overdue.length,
      today: grouped.today.length,
      upcoming: grouped.upcoming.length,
      completed: grouped.completed.length
    };

    const tasks = {};
    buckets.forEach((bucket) => {
      if (requestedBucket && requestedBucket !== bucket) {
        tasks[bucket] = [];
        return;
      }
      const rows = sortBucketRows(bucket, grouped[bucket]);
      const capped = bucket === "completed" ? rows.slice(0, 50) : rows;
      tasks[bucket] = capped.slice(offset, offset + limit);
    });

    return res.status(200).json({ ok: true, tasks, counts });
  } catch (err) {
    console.error("admin-crm-tasks error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
