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

const COMPLETED_BOOKING_STATUSES = ["completed", "complete", "done"];
const ACTIVE_BOOKING_STATUSES = ["pending", "confirmed"];

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

async function loadPrimaryVehicles(supabase, customerIds) {
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const { data, error } = await supabase
    .from("vehicles")
    .select("*")
    .in("customer_id", ids)
    .order("created_at", { ascending: false });

  if (error) throw error;

  const byCustomer = new Map();
  for (const vehicle of data || []) {
    if (!vehicle.customer_id || byCustomer.has(vehicle.customer_id)) continue;
    byCustomer.set(vehicle.customer_id, vehicle);
  }
  return byCustomer;
}

async function loadBookingStateSummary(supabase, customerIds) {
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const { data, error } = await supabase
    .from("bookings")
    .select("customer_id, status, scheduled_start")
    .in("customer_id", ids);

  if (error) throw error;

  const byCustomer = new Map();
  for (const booking of data || []) {
    const customerId = booking.customer_id;
    if (!customerId) continue;
    const status = String(booking.status || "").trim().toLowerCase();
    const current = byCustomer.get(customerId) || {
      total_bookings: 0,
      active_booking_count: 0,
      pending_booking_count: 0,
      confirmed_booking_count: 0,
      completed_bookings: 0,
      latest_booking_status: null,
      latest_booking_at: null
    };
    current.total_bookings += 1;
    if (ACTIVE_BOOKING_STATUSES.includes(status)) current.active_booking_count += 1;
    if (status === "pending") current.pending_booking_count += 1;
    if (status === "confirmed") current.confirmed_booking_count += 1;
    if (COMPLETED_BOOKING_STATUSES.includes(status)) current.completed_bookings += 1;

    const stamp = booking.scheduled_start;
    if (stamp && (!current.latest_booking_at || new Date(stamp).getTime() > new Date(current.latest_booking_at).getTime())) {
      current.latest_booking_at = stamp;
      current.latest_booking_status = status || null;
    }
    byCustomer.set(customerId, current);
  }
  return byCustomer;
}

function applyBookingSummary(row, bookingSummary) {
  const customerId = row.customer_id || row.id;
  const summary = bookingSummary.get(customerId);
  if (!summary) {
    return {
      ...row,
      total_revenue: 0,
      completed_bookings: 0
    };
  }
  return {
    ...row,
    total_revenue: Math.round(summary.total_revenue * 100) / 100,
    completed_bookings: summary.completed_bookings,
    last_service_date: summary.last_service_date || row.last_service_date
  };
}

function applyPrimaryVehicle(row, primaryVehicles) {
  const customerId = row.customer_id || row.id;
  return {
    ...row,
    primary_vehicle: primaryVehicles.get(customerId) || null
  };
}

function applyBookingStateSummary(row, bookingStates) {
  const customerId = row.customer_id || row.id;
  const summary = bookingStates.get(customerId);
  if (!summary) {
    return {
      ...row,
      total_bookings: Number(row.total_bookings) || 0,
      active_booking_count: 0,
      pending_booking_count: 0,
      confirmed_booking_count: 0,
      latest_booking_status: null
    };
  }
  return {
    ...row,
    total_bookings: summary.total_bookings,
    active_booking_count: summary.active_booking_count,
    pending_booking_count: summary.pending_booking_count,
    confirmed_booking_count: summary.confirmed_booking_count,
    completed_bookings: summary.completed_bookings,
    latest_booking_status: summary.latest_booking_status
  };
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
    const customerIds = (data || []).map((row) => row.customer_id || row.id);
    const [bookingSummary, primaryVehicles, bookingStates] = await Promise.all([
      loadCompletedBookingSummary(supabase, customerIds),
      loadPrimaryVehicles(supabase, customerIds),
      loadBookingStateSummary(supabase, customerIds)
    ]);

    const customers = (data || []).map((row) =>
      applyPrimaryVehicle(applyBookingStateSummary(applyBookingSummary(row, bookingSummary), bookingStates), primaryVehicles)
    );

    return res.status(200).json({
      ok: true,
      customers,
      count: count || 0
    });
  } catch (err) {
    console.error("admin-crm-customers error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
