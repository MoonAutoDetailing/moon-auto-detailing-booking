import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { isIsoDate } from "../_jobs.js";
import { payWeek } from "../_timeclock.js";

const TEST_NOTE = /^\s*TEST ACCOUNT/i;
const r2 = (n) => Math.round(n * 100) / 100;

/** Pure: weekly revenue + payments from booking rows (with job_payments embedded). */
export function summarizePayments(bookings) {
  const done = [];
  const upcoming = [];
  for (const b of bookings) {
    if (TEST_NOTE.test(b.customer_notes || "")) continue;
    if (b.status === "completed") done.push(b);
    else if (b.status === "confirmed") upcoming.push(b);
  }
  const byMethod = {};
  let collected = 0;
  let tips = 0;
  let short = 0;
  const jobs = done.map((b) => {
    const pays = b.job_payments || [];
    const amount = pays.reduce((t, p) => t + Number(p.amount_collected || 0), 0);
    const tip = pays.reduce((t, p) => t + Number(p.tip_amount || 0), 0);
    const total = Number(b.total_price || 0);
    const method = pays[0]?.payment_method || null;
    collected += amount;
    tips += tip;
    if (amount + 0.005 < total) short += total - amount;
    if (method) byMethod[method] = r2((byMethod[method] || 0) + amount);
    return {
      id: b.id,
      scheduled_start: b.scheduled_start,
      customer: b.customers?.full_name || "Customer",
      service: b.service_variants?.services ? `${b.service_variants.services.category} L${b.service_variants.services.level}` : "Service",
      total: r2(total),
      collected: r2(amount),
      tip: r2(tip),
      method,
      recorded_by: pays[0]?.recorded_by || null,
      short: amount + 0.005 < total ? r2(total - amount) : 0,
      unpaid: pays.length === 0,
    };
  });
  const expected = upcoming.reduce((t, b) => t + Number(b.total_price || 0), 0);
  return {
    totals: {
      collected: r2(collected),
      jobs: done.length,
      average_ticket: done.length ? r2(collected / done.length) : 0,
      tips: r2(tips),
      short: r2(short),
      still_to_collect: r2(expected),
      jobs_remaining: upcoming.length,
    },
    by_method: byMethod,
    jobs,
  };
}

/**
 * Weekly revenue & customer payments (owner and manager).
 * GET ?week=YYYY-MM-DD → completed jobs in that Monday–Sunday week with what was collected,
 * tips and payment method; totals by method; jobs that came in under their price; and the
 * confirmed jobs still to come this week. The owner's TEST ACCOUNT bookings are excluded.
 */
export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const sb = serviceClient();
    const week = payWeek(isIsoDate(req.query?.week) ? req.query.week : todayNY());
    const [{ data, error }, { data: staff, error: sErr }] = await Promise.all([
      sb
        .from("bookings")
        .select("id, scheduled_start, status, total_price, customer_notes, customers:customer_id ( full_name ), service_variants:service_variant_id ( services:service_id ( category, level ) ), job_payments ( amount_collected, tip_amount, payment_method, recorded_by )")
        .in("status", ["completed", "confirmed"])
        .gte("scheduled_start", week.startISO)
        .lt("scheduled_start", week.endISO)
        .order("scheduled_start"),
      sb.from("staff").select("id, full_name"),
    ]);
    if (error) throw error;
    if (sErr) throw sErr;
    const names = new Map((staff || []).map((s) => [s.id, s.full_name]));
    const summary = summarizePayments(data || []);
    summary.jobs = summary.jobs.map((j) => ({ ...j, recorded_by: names.get(j.recorded_by) || (j.recorded_by === "legacy-admin" ? "Owner" : null) }));
    return res.status(200).json({ week: { start: week.weekStart, end: week.weekEnd }, this_week: payWeek(todayNY()).weekStart, ...summary });
  } catch (err) {
    console.error("admin-payments error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
