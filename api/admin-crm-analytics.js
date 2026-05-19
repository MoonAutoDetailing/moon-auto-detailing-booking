import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const MS_DAY = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 12;
const POSITIVE_RESPONSES = new Set([
  "interested",
  "booked",
  "scheduled",
  "positive",
  "replied",
  "yes"
]);
const BOOKED_RESPONSES = new Set(["booked", "scheduled"]);

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function extractCity(address) {
  if (!address) return "Unknown";
  const text = String(address).trim();
  if (!text) return "Unknown";
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const candidate = parts[parts.length - 2];
    return candidate.replace(/\d{5}(-\d{4})?/g, "").trim() || candidate || "Unknown";
  }
  return parts[0] || "Unknown";
}

function monthKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function sortDescByCount(entries) {
  return [...entries].sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));
}

function topEntries(map, limit = LIST_LIMIT) {
  return sortDescByCount(
    [...map.entries()].map(([label, count]) => ({ label, count }))
  ).slice(0, limit);
}

async function fetchAllRows(supabase, table, select, applyFilter) {
  const rows = [];
  let from = 0;
  const pageSize = 1000;

  while (from < 20000) {
    let query = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (applyFilter) query = applyFilter(query);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

async function safeSection(warnings, label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error(`admin-crm-analytics: ${label}`, err);
    warnings.push(`${label}: ${err.message || "failed"}`);
    return typeof fallback === "function" ? fallback() : fallback;
  }
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
    console.error("admin-crm-analytics: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const warnings = [];

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const now = Date.now();
    const contactCutoff = new Date(now - 30 * MS_DAY).toISOString();
    const reactivationCutoff = new Date(now - 90 * MS_DAY).toISOString();

    const summaryRows = await safeSection(
      warnings,
      "crm_customer_summary",
      () => fetchAllRows(supabase, "crm_customer_summary", "*"),
      []
    );

    const outreachLogs = await safeSection(
      warnings,
      "crm_outreach_logs",
      () => fetchAllRows(supabase, "crm_outreach_logs", "id, response_status, customer_id, contacted_at"),
      []
    );

    const followUpTasks = await safeSection(
      warnings,
      "crm_follow_up_tasks",
      () => fetchAllRows(supabase, "crm_follow_up_tasks", "id, status, due_at, customer_id"),
      []
    );

    const bookings = await safeSection(
      warnings,
      "bookings",
      () => fetchAllRows(
        supabase,
        "bookings",
        "id, status, scheduled_start, total_price, service_address, customer_id, service_variant_id"
      ),
      []
    );

    const vehicles = await safeSection(
      warnings,
      "vehicles",
      () => fetchAllRows(supabase, "vehicles", "id, vehicle_size, customer_id"),
      []
    );

    const serviceVariants = await safeSection(
      warnings,
      "service_variants",
      async () => {
        const joined = await fetchAllRows(
          supabase,
          "service_variants",
          "id, vehicle_size, service_id, services:service_id ( category, level )"
        );
        return joined;
      },
      []
    );

    const variantCategoryById = new Map();
    for (const variant of serviceVariants) {
      const category = variant.services?.category || variant.service?.category || "Unknown";
      variantCategoryById.set(variant.id, category);
    }

    const completedBookings = bookings.filter((row) => normalize(row.status) === "completed");
    const completedCount = completedBookings.length;
    const totalCompletedRevenue = completedBookings.reduce(
      (sum, row) => sum + (Number(row.total_price) || 0),
      0
    );

    const completedByCustomer = new Map();
    for (const booking of completedBookings) {
      if (!booking.customer_id) continue;
      completedByCustomer.set(
        booking.customer_id,
        (completedByCustomer.get(booking.customer_id) || 0) + 1
      );
    }

    const revenueByMonth = new Map();
    const revenueByCategory = new Map();
    const revenueByCity = new Map();

    for (const booking of completedBookings) {
      const amount = Number(booking.total_price) || 0;
      const key = monthKey(booking.scheduled_start);
      if (key) revenueByMonth.set(key, (revenueByMonth.get(key) || 0) + amount);

      const category = variantCategoryById.get(booking.service_variant_id) || "Unknown";
      revenueByCategory.set(category, (revenueByCategory.get(category) || 0) + amount);

      const city = extractCity(booking.service_address);
      revenueByCity.set(city, (revenueByCity.get(city) || 0) + amount);
    }

    const outreachByStatus = new Map();
    let positiveResponses = 0;
    let bookedFromOutreach = 0;

    for (const log of outreachLogs) {
      const status = normalize(log.response_status) || "no_response";
      outreachByStatus.set(status, (outreachByStatus.get(status) || 0) + 1);
      if (POSITIVE_RESPONSES.has(status)) positiveResponses += 1;
      if (BOOKED_RESPONSES.has(status)) bookedFromOutreach += 1;
    }

    const totalOutreach = outreachLogs.length;
    const responseRate = totalOutreach > 0
      ? roundMoney((positiveResponses / totalOutreach) * 100)
      : 0;

    const openTasks = followUpTasks.filter((task) => normalize(task.status) === "open");
    const overdueTasks = openTasks.filter((task) => {
      if (!task.due_at) return false;
      return new Date(task.due_at).getTime() < now;
    });

    let totalLeads = 0;
    let activeCustomers = 0;
    let coolingCustomers = 0;
    let inactiveCustomers = 0;
    let highPriorityContacts = 0;
    let overdueFollowups = 0;
    let openFollowups = 0;
    let repeatCustomers = 0;

    const activeStatuses = new Set([
      "active",
      "booked",
      "confirmed",
      "new",
      "nurture",
      "repeat_customer",
      "completed_customer"
    ]);
    const inactiveStatuses = new Set(["inactive", "cooling", "do_not_contact", "ghosted", "lost"]);

    for (const row of summaryRows) {
      const stage = normalize(row.lifecycle_stage);
      const status = normalize(row.crm_status || row.status);

      if (stage === "lead") totalLeads += 1;
      if (status === "cooling") coolingCustomers += 1;
      if (status === "inactive") inactiveCustomers += 1;

      const priority = normalize(row.crm_priority || row.priority);
      if (priority === "high" || priority === "urgent") highPriorityContacts += 1;

      if (activeStatuses.has(status) && !inactiveStatuses.has(status)) activeCustomers += 1;
      if (row.next_follow_up_at) {
        openFollowups += 1;
        if (new Date(row.next_follow_up_at).getTime() < now) overdueFollowups += 1;
      }

      const customerId = row.customer_id || row.id;
      if ((completedByCustomer.get(customerId) || 0) >= 2) repeatCustomers += 1;
    }

    const topLifetimeValue = [...summaryRows]
      .sort((a, b) => Number(b.total_revenue || 0) - Number(a.total_revenue || 0))
      .slice(0, LIST_LIMIT)
      .map((row) => ({
        customer_id: row.customer_id || row.id,
        full_name: row.full_name,
        total_revenue: roundMoney(row.total_revenue),
        lifecycle_stage: row.lifecycle_stage,
        crm_status: row.crm_status || row.status
      }));

    const notContactedRecently = summaryRows
      .filter((row) => {
        if (!row.last_contacted_at) return true;
        return new Date(row.last_contacted_at).getTime() < new Date(contactCutoff).getTime();
      })
      .sort((a, b) => {
        const aTime = a.last_contacted_at ? new Date(a.last_contacted_at).getTime() : 0;
        const bTime = b.last_contacted_at ? new Date(b.last_contacted_at).getTime() : 0;
        return aTime - bTime;
      })
      .slice(0, LIST_LIMIT)
      .map((row) => ({
        customer_id: row.customer_id || row.id,
        full_name: row.full_name,
        last_contacted_at: row.last_contacted_at,
        crm_status: row.crm_status || row.status
      }));

    const reactivationOpportunities = summaryRows
      .filter((row) => {
        if (Number(row.total_revenue || 0) < 300) return false;
        if (!row.last_service_date) return false;
        return new Date(row.last_service_date).getTime() <= new Date(reactivationCutoff).getTime();
      })
      .sort((a, b) => Number(b.total_revenue || 0) - Number(a.total_revenue || 0))
      .slice(0, LIST_LIMIT)
      .map((row) => ({
        customer_id: row.customer_id || row.id,
        full_name: row.full_name,
        total_revenue: roundMoney(row.total_revenue),
        last_service_date: row.last_service_date
      }));

    const vehicleSizeCounts = new Map();
    for (const vehicle of vehicles) {
      const size = normalize(vehicle.vehicle_size) || "unknown";
      vehicleSizeCounts.set(size, (vehicleSizeCounts.get(size) || 0) + 1);
    }

    const serviceCounts = new Map();
    for (const booking of bookings) {
      const category = variantCategoryById.get(booking.service_variant_id) || "Unknown";
      serviceCounts.set(category, (serviceCounts.get(category) || 0) + 1);
    }

    const totalBookings = bookings.length;
    const terminalBookings = bookings.filter((row) => {
      const status = normalize(row.status);
      return status === "completed" || status === "cancelled" || status === "denied";
    }).length;
    const completionRate = terminalBookings > 0
      ? roundMoney((completedCount / terminalBookings) * 100)
      : 0;

    const revenueMonths = [...revenueByMonth.entries()]
      .map(([month, revenue]) => ({ month, revenue: roundMoney(revenue) }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-LIST_LIMIT);

    return res.status(200).json({
      ok: true,
      kpis: {
        total_customers: summaryRows.length,
        total_leads: totalLeads,
        active_customers: activeCustomers,
        repeat_customers: repeatCustomers,
        cooling_customers: coolingCustomers,
        inactive_customers: inactiveCustomers,
        high_priority_contacts: highPriorityContacts,
        overdue_followups: Math.max(overdueFollowups, overdueTasks.length),
        open_followups: Math.max(openFollowups, openTasks.length),
        total_completed_revenue: roundMoney(totalCompletedRevenue),
        average_ticket: completedCount > 0
          ? roundMoney(totalCompletedRevenue / completedCount)
          : 0
      },
      revenue: {
        by_month: revenueMonths,
        by_service_category: topEntries(revenueByCategory).map((row) => ({
          category: row.label,
          revenue: roundMoney(revenueByCategory.get(row.label))
        })),
        by_city: topEntries(revenueByCity).map((row) => ({
          city: row.label,
          revenue: roundMoney(revenueByCity.get(row.label))
        }))
      },
      outreach: {
        total_outreach_logs: totalOutreach,
        response_rate: responseRate,
        booked_from_outreach: bookedFromOutreach,
        by_response_status: topEntries(outreachByStatus).map((row) => ({
          status: row.label,
          count: row.count
        }))
      },
      customers: {
        top_lifetime_value: topLifetimeValue,
        not_contacted_recently: notContactedRecently,
        reactivation_opportunities: reactivationOpportunities
      },
      operations: {
        completed_jobs: completedCount,
        total_bookings: totalBookings,
        completion_rate: completionRate,
        most_common_vehicle_sizes: topEntries(vehicleSizeCounts).map((row) => ({
          vehicle_size: row.label,
          count: row.count
        })),
        most_common_services: topEntries(serviceCounts).map((row) => ({
          service_category: row.label,
          count: row.count
        }))
      },
      warnings
    });
  } catch (err) {
    console.error("admin-crm-analytics error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
