import { DateTime } from "luxon";
import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { isIsoDate } from "../_jobs.js";
import { payWeek, minutesWithin } from "../_timeclock.js";
import { summarizeBusiness } from "../_payroll.js";

const TZ = "America/New_York";
const TEST_NOTE = /^\s*TEST ACCOUNT/i;

/** The period containing dateStr, plus the `count - 1` periods before it (oldest first). */
export function periods(kind, dateStr, count = 8) {
  const out = [];
  let anchor = DateTime.fromISO(dateStr, { zone: TZ });
  for (let i = 0; i < count; i++) {
    if (kind === "week") {
      const w = payWeek(anchor.toISODate());
      out.unshift({ key: w.weekStart, label: DateTime.fromISO(w.weekStart).toFormat("LLL d"), startISO: w.startISO, endISO: w.endISO, startDate: w.weekStart, endDate: w.weekEnd });
      anchor = anchor.minus({ weeks: 1 });
    } else {
      const s = anchor.startOf("month");
      const e = s.plus({ months: 1 });
      out.unshift({ key: s.toFormat("yyyy-LL"), label: s.toFormat("LLL yyyy"), startISO: s.toUTC().toISO(), endISO: e.toUTC().toISO(), startDate: s.toISODate(), endDate: e.minus({ days: 1 }).toISODate() });
      anchor = anchor.minus({ months: 1 });
    }
  }
  return out;
}

/**
 * Business dashboard (owner / manager).
 * GET ?period=week|month&date=YYYY-MM-DD → summary for the period containing `date` and an
 * 8-period trend: revenue (amount collected), tips, jobs, average ticket, expenses (direct +
 * operating), labor (clocked hours × hourly rate, before overtime), profit and margin.
 * The owner's TEST ACCOUNT bookings are excluded.
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
    const kind = req.query?.period === "week" ? "week" : "month";
    const date = isIsoDate(req.query?.date) ? req.query.date : todayNY();
    const ps = periods(kind, date);
    const first = ps[0];
    const last = ps[ps.length - 1];

    const [{ data: jobs, error: jErr }, { data: expenses, error: eErr }, { data: entries, error: tErr }, { data: staff, error: sErr }] =
      await Promise.all([
        sb
          .from("bookings")
          .select("id, scheduled_start, customer_notes, job_payments ( amount_collected, tip_amount )")
          .eq("status", "completed")
          .gte("scheduled_start", first.startISO)
          .lt("scheduled_start", last.endISO),
        sb
          .from("expenses")
          .select("expense_date, expense_type, amount")
          .eq("status", "approved")
          .gte("expense_date", first.startDate)
          .lte("expense_date", last.endDate),
        sb
          .from("time_entries")
          .select("staff_id, clock_in_at, clock_out_at")
          .is("voided_at", null)
          .gte("clock_in_at", new Date(Date.parse(first.startISO) - 24 * 3600000).toISOString())
          .lt("clock_in_at", last.endISO),
        sb.from("staff").select("id, hourly_rate"),
      ]);
    for (const e of [jErr, eErr, tErr, sErr]) if (e) throw e;

    const rate = new Map((staff || []).map((s) => [s.id, s.hourly_rate != null ? Number(s.hourly_rate) : 0]));
    const realJobs = (jobs || [])
      .filter((b) => !TEST_NOTE.test(b.customer_notes || ""))
      .map((b) => ({
        at: Date.parse(b.scheduled_start),
        amount_collected: (b.job_payments || []).reduce((t, p) => t + Number(p.amount_collected || 0), 0),
        tip_amount: (b.job_payments || []).reduce((t, p) => t + Number(p.tip_amount || 0), 0),
      }));

    const series = ps.map((p) => {
      const s = Date.parse(p.startISO);
      const e = Date.parse(p.endISO);
      let minutes = 0;
      let labor = 0;
      for (const t of entries || []) {
        const m = minutesWithin(t, p.startISO, p.endISO);
        minutes += m;
        labor += (m / 60) * (rate.get(t.staff_id) || 0);
      }
      return {
        key: p.key,
        label: p.label,
        start: p.startDate,
        end: p.endDate,
        ...summarizeBusiness({
          jobs: realJobs.filter((j) => j.at >= s && j.at < e),
          expenses: (expenses || []).filter((x) => x.expense_date >= p.startDate && x.expense_date <= p.endDate),
          laborCost: labor,
          hours: minutes / 60,
        }),
      };
    });

    return res.status(200).json({ period: kind, date, current: series[series.length - 1], series });
  } catch (err) {
    console.error("admin-analytics error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
