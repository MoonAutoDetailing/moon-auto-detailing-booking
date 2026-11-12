import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { payWeek } from "../_timeclock.js";
import { addDays } from "../_schedule.js";
import { reviewDenied } from "../_expenses.js";

const H = 3600000;

/** Pure: turns the raw counts into the Today screen's "Needs attention" list (most urgent first). */
export function attentionItems(c, { isOwner }) {
  const items = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (c.forgotClockOut.length) {
    items.push({ key: "clock", icon: "clock", view: "timeclock", tone: "bad",
      title: `${plural(c.forgotClockOut.length, "person", "people")} still clocked in after 12+ hours`,
      detail: c.forgotClockOut.join(", ") + " — fix the time entry" });
  }
  if (c.overdueJobs) {
    items.push({ key: "overdue", icon: "check", view: "overdue", tone: "warn",
      title: `${plural(c.overdueJobs, "job", "jobs")} finished but not marked complete`,
      detail: "Complete them so payment and the customer email are recorded" });
  }
  if (c.timeOff) {
    items.push({ key: "timeoff", icon: "calendar", view: "schedule", tone: "warn",
      title: `${plural(c.timeOff, "time-off request", "time-off requests")} to review`, detail: "Approve or deny in Crew schedule" });
  }
  // c.expenses only counts receipts this person may approve (managers: employees' receipts).
  if (c.expenses) {
    items.push({ key: "expenses", icon: "receipt", view: "expenses", tone: "warn",
      title: `${plural(c.expenses, "expense", "expenses")} waiting for your approval`, detail: isOwner ? "Includes managers' own expenses" : "Crew receipts" });
  }
  if (isOwner && c.expenseReport) {
    items.push({ key: "expense-report", icon: "receipt", view: "expense-report", tone: "warn",
      title: "Last week's expense report is ready to review",
      detail: `${plural(c.expenseReport.count, "expense", "expenses")} · $${c.expenseReport.total.toFixed(2)}` });
  }
  if (c.payrollOwnerNeeded && isOwner) {
    items.push({ key: "payroll", icon: "payroll", view: "payroll", tone: "info",
      title: "Last week's payroll needs your approval", detail: "The crew's pay is signed off; managers' pay is yours to approve" });
  } else if (c.payrollReady) {
    items.push({ key: "payroll", icon: "payroll", view: "payroll", tone: "info",
      title: "Last week's payroll is ready to approve", detail: `${c.payrollHours.toFixed(1)} hours clocked` });
  }
  if (c.drafts) {
    items.push({ key: "drafts", icon: "send", view: "schedule", tone: "info",
      title: `${plural(c.drafts, "draft shift", "draft shifts")} not published`, detail: "The crew can't see them until you publish" });
  }
  if (c.onClock.length) {
    items.push({ key: "onclock", icon: "users", view: "timeclock", tone: "ok",
      title: `On the clock: ${c.onClock.join(", ")}`, detail: "" });
  }
  return items;
}

/**
 * GET → { items } for the Today screen: things that need someone to act on them today.
 * Pending booking requests are already on Today, so they aren't repeated here.
 */
export default async function handler(req, res) {
  let actor;
  try {
    ({ admin: actor } = await verifyAdmin(req));
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const sb = serviceClient();
    const now = Date.now();
    const today = todayNY();
    const thisWeek = payWeek(today);
    const lastWeek = payWeek(addDays(thisWeek.weekStart, -7));
    const nextWeekEnd = addDays(thisWeek.weekEnd, 7);

    const [
      { data: open, error: e1 },
      { data: overdue, error: e2 },
      { count: timeOff, error: e3 },
      { data: pendingExpenses, error: e4 },
      { data: lastWeekEntries, error: e5 },
      { data: lastRun, error: e6 },
      { count: drafts, error: e7 },
      { data: staffRoles, error: e8 },
      { data: lastWeekExpenses, error: e9 },
      { data: lastReport, error: e10 },
    ] = await Promise.all([
      sb.from("time_entries").select("clock_in_at, staff:staff_id ( full_name )").is("clock_out_at", null).is("voided_at", null),
      // Same rule as the Bookings → Not completed list: confirmed, ended over an hour ago.
      sb.from("bookings").select("id").eq("status", "confirmed").lt("scheduled_end", new Date(now - H).toISOString()),
      sb.from("time_off_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
      sb.from("expenses").select("id, submitted_by_staff_id").eq("status", "pending"),
      sb.from("time_entries").select("clock_in_at, clock_out_at").is("voided_at", null).gte("clock_in_at", lastWeek.startISO).lt("clock_in_at", lastWeek.endISO),
      sb.from("payroll_runs").select("status, crew_approved_at").eq("week_start", lastWeek.weekStart).maybeSingle(),
      sb.from("shifts").select("id", { count: "exact", head: true }).eq("published", false).gte("shift_date", today).lte("shift_date", nextWeekEnd),
      sb.from("staff").select("id, role"),
      sb.from("expenses").select("amount, status").gte("created_at", lastWeek.startISO).lt("created_at", lastWeek.endISO),
      sb.from("expense_reports").select("week_start").eq("week_start", lastWeek.weekStart).maybeSingle(),
    ]);
    for (const e of [e1, e2, e3, e4, e5, e6, e7, e8, e9, e10]) if (e) throw e;
    const roleOf = new Map((staffRoles || []).map((s) => [s.id, s]));
    const counted = (lastWeekExpenses || []).filter((x) => x.status !== "rejected");

    const first = (n) => String(n || "Someone").split(" ")[0];
    const payrollHours = (lastWeekEntries || []).reduce((t, x) => t + ((x.clock_out_at ? Date.parse(x.clock_out_at) : now) - Date.parse(x.clock_in_at)) / H, 0);
    const counts = {
      forgotClockOut: (open || []).filter((o) => now - Date.parse(o.clock_in_at) > 12 * H).map((o) => first(o.staff?.full_name)),
      onClock: (open || []).filter((o) => now - Date.parse(o.clock_in_at) <= 12 * H).map((o) => first(o.staff?.full_name)),
      overdueJobs: (overdue || []).length,
      timeOff: timeOff || 0,
      expenses: (pendingExpenses || []).filter((x) => !reviewDenied(actor, roleOf.get(x.submitted_by_staff_id))).length,
      expenseReport: !lastReport && counted.length
        ? { count: counted.length, total: counted.reduce((t, x) => t + Math.round(Number(x.amount) * 100), 0) / 100 }
        : null,
      // A manager's sign-off covers the crew; the owner finishes weeks that include managers' pay.
      payrollReady: payrollHours > 0 && (!lastRun || (lastRun.status === "draft" && !lastRun.crew_approved_at)),
      payrollOwnerNeeded: !!lastRun && lastRun.status === "draft" && !!lastRun.crew_approved_at,
      payrollHours,
      drafts: drafts || 0,
    };
    return res.status(200).json({ items: attentionItems(counts, { isOwner: actor.role === "owner" }) });
  } catch (err) {
    console.error("admin-attention error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
