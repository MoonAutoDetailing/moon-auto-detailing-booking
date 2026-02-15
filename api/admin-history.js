
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import { verifyAdmin } from "./_verifyAdmin.js";


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


export default async function handler(req, res) {
   if (!verifyAdmin(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    requireAdmin(req);

    const SUPABASE_URL = requireEnv("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize || "10", 10)));

    const q = (req.query.q || "").toString().trim();
    const date = (req.query.date || "").toString().trim();

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let dayStartISO = null;
    let dayEndISO = null;

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
      const { data: customers, error: custErr } = await supabase
        .from("customers")
        .select("id")
        .ilike("full_name", `%${q}%`)
        .limit(500);

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
  )
`, { count: "exact" })

      .in("status", HISTORY_STATUSES)
      .order("scheduled_start", { ascending: false })
      .range(from, to);

    if (customerIds) {
      query = query.in("customer_id", customerIds);
    }

    if (dayStartISO && dayEndISO) {
      query = query
        .gte("scheduled_start", dayStartISO)
        .lt("scheduled_start", dayEndISO);
    }

    const { data, count, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      rows: data || [],
      totalCount: count || 0,
      page,
      pageSize
    });

  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({
      error: e.message || "Server error"
    });
  }
}

export default handler;
