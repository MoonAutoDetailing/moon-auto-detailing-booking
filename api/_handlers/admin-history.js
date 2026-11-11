
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import verifyAdmin from "../_verifyAdmin.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const HISTORY_STATUSES = [
  "completed",
  "no_show",
  "cancelled",
  "reschedule_requested",
  "rescheduled",
  "denied"
];

// ?status= filter groups for the History tab.
export const STATUS_GROUPS = {
  all: HISTORY_STATUSES,
  completed: ["completed"],
  cancelled: ["cancelled", "denied", "no_show"],
  rescheduled: ["reschedule_requested", "rescheduled"]
};

/** Customer search terms are matched against name, email and phone; PostgREST-safe. */
export function customerSearchFilter(q) {
  const safe = String(q || "").replace(/[%,()*]/g, " ").trim();
  if (!safe) return null;
  const digits = safe.replace(/\D/g, "");
  const parts = [`full_name.ilike.%${safe}%`, `email.ilike.%${safe}%`];
  if (digits.length >= 3) parts.push(`phone.ilike.%${digits.split("").join("%")}%`);
  return parts.join(",");
}


export default async function handler(req, res) {
   try {
  await verifyAdmin(req);
} catch (err) {
  console.error("admin-history: auth failed", err.message);
  return res.status(401).json({ error: "Unauthorized" });
}

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize || "10", 10)));

    const q = (req.query.q || "").toString().trim();
    const date = (req.query.date || "").toString().trim();
    const statuses = STATUS_GROUPS[(req.query.status || "all").toString()] || STATUS_GROUPS.all;
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : null;
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : null;

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let dayStartISO = null;
    let dayEndISO = null;

    // ?from=&to= (inclusive New York dates) — used by the History range picker.
    if (!date && (fromDate || toDate)) {
      if (fromDate) dayStartISO = DateTime.fromISO(fromDate, { zone: "America/New_York" }).startOf("day").toUTC().toISO();
      if (toDate) dayEndISO = DateTime.fromISO(toDate, { zone: "America/New_York" }).startOf("day").plus({ days: 1 }).toUTC().toISO();
    }

    if (date) {
      const dt = DateTime.fromISO(date, { zone: "America/New_York" });
      if (!dt.isValid) {
        return res.status(400).json({ error: "Invalid date format" });
      }

      const start = dt.startOf("day");
      const end = start.plus({ days: 1 });

      dayStartISO = start.toUTC().toISO();
      dayEndISO = end.toUTC().toISO();
    }

    let customerIds = null;

    if (q) {
      const filter = customerSearchFilter(q);
      const { data: customers, error: custErr } = filter
        ? await supabase.from("customers").select("id").or(filter).limit(500)
        : { data: [], error: null };

      if (custErr) throw custErr;

      customerIds = customers.map(c => c.id);

      if (customerIds.length === 0) {
        return res.status(200).json({
          rows: [],
          totalCount: 0,
          page,
          pageSize
        });
      }
    }

    let query = supabase
      .from("bookings")
      .select(`
  id,
  scheduled_start,
  scheduled_end,
  service_address,
  status,
  google_event_id,
  base_price,
  travel_fee,
  total_price,
  discount_code,
  discount_percent,
  discount_amount,
  customer_notes,
  job_flag,
  crew_notes,
  customers:customer_id (
    full_name,
    phone
  ),
  vehicles:vehicle_id (
    vehicle_year,
    vehicle_make,
    vehicle_model
  ),
  service_variants:service_variant_id (
    duration_minutes,
    services:service_id (
      category,
      level
    )
  ),
  job_payments (
    amount_collected,
    tip_amount,
    payment_method
  )
`, { count: "exact" })

      .in("status", statuses)
      .order("scheduled_start", { ascending: false })
      .range(from, to);

    if (customerIds) {
      query = query.in("customer_id", customerIds);
    }

    if (dayStartISO) query = query.gte("scheduled_start", dayStartISO);
    if (dayEndISO) query = query.lt("scheduled_start", dayEndISO);

    const { data, count, error } = await query;
    if (error) throw error;

    // Total collected across every matching booking (not just this page).
    let sumQuery = supabase
      .from("bookings")
      .select("id, job_payments ( amount_collected )")
      .in("status", statuses)
      .limit(5000);
    if (customerIds) sumQuery = sumQuery.in("customer_id", customerIds);
    if (dayStartISO) sumQuery = sumQuery.gte("scheduled_start", dayStartISO);
    if (dayEndISO) sumQuery = sumQuery.lt("scheduled_start", dayEndISO);
    const { data: sumRows, error: sumErr } = await sumQuery;
    if (sumErr) throw sumErr;
    const collected = (sumRows || []).reduce(
      (t, b) => t + (b.job_payments || []).reduce((s, p) => s + Number(p.amount_collected || 0), 0),
      0
    );

    return res.status(200).json({
      rows: data || [],
      totalCount: count || 0,
      page,
      pageSize,
      collected: Math.round(collected * 100) / 100
    });

  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({
      error: e.message || "Server error"
    });
  }
}

