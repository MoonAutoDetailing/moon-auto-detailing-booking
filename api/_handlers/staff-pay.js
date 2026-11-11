import { requireRole, ROLES, serviceClient, sendAuthError } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { payWeek } from "../_timeclock.js";
import { addDays } from "../_schedule.js";
import { loadPayroll } from "../_payrollData.js";

const blank = { regular_hours: 0, overtime_hours: 0, regular_pay: 0, overtime_pay: 0, tips: 0, reimbursements: 0, total: 0, hourly_rate: null, warnings: [] };

/**
 * GET → the signed-in person's pay: this week so far and last week (estimates until
 * approved), plus approved/paid weeks from payroll.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const sb = serviceClient();
  let staff;
  try {
    staff = await requireRole(req, ROLES, { sb });
  } catch (err) {
    if (sendAuthError(res, err)) return;
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const thisWeek = payWeek(todayNY());
    const lastWeek = payWeek(addDays(thisWeek.weekStart, -7));
    const estimate = async (week) => {
      const r = await loadPayroll(sb, week, { staffId: staff.id });
      const { details, staff_id, full_name, ...line } = r.lines.find((l) => l.staff_id === staff.id) || blank;
      return { start: week.weekStart, end: week.weekEnd, ...blank, ...line };
    };

    const [current, previous, { data: history, error }] = await Promise.all([
      estimate(thisWeek),
      estimate(lastWeek),
      sb
        .from("payroll_lines")
        .select("regular_hours, overtime_hours, regular_pay, overtime_pay, tips, reimbursements, total, payment_method, run:run_id ( week_start, week_end, status, paid_at )")
        .eq("staff_id", staff.id)
        .order("created_at", { ascending: false })
        .limit(12),
    ]);
    if (error) throw error;

    const paidWeeks = (history || [])
      .filter((h) => h.run)
      .map(({ run, ...h }) => ({
        start: run.week_start,
        end: run.week_end,
        status: run.status,
        paid_at: run.paid_at,
        ...Object.fromEntries(Object.entries(h).map(([k, v]) => [k, k === "payment_method" ? v : Number(v)])),
      }))
      .sort((a, b) => (a.start < b.start ? 1 : -1));
    const lastWeekFrozen = paidWeeks.find((w) => w.start === lastWeek.weekStart);

    return res.status(200).json({
      rate: staff.hourly_rate != null ? Number(staff.hourly_rate) : null,
      this_week: current,
      last_week: lastWeekFrozen || { ...previous, status: "estimate" },
      history: paidWeeks,
    });
  } catch (err) {
    console.error("staff-pay error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
