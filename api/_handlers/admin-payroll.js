import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient, parseBody } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { isIsoDate } from "../_jobs.js";
import { payWeek } from "../_timeclock.js";
import { payrollCsv } from "../_payroll.js";
import { loadPayroll } from "../_payrollData.js";

const RUN_COLS = "id, week_start, week_end, status, approved_by, approved_at, paid_by, paid_at, notes, crew_approved_by, crew_approved_at";
const METHODS = ["Direct deposit", "Check", "Cash", "Venmo", "PayPal", "Zelle", "Payroll service", "Other"];

async function frozenLines(sb, runId) {
  const { data, error } = await sb
    .from("payroll_lines")
    .select("staff_id, hourly_rate, regular_hours, overtime_hours, regular_pay, overtime_pay, tips, reimbursements, total, payment_method, details, staff:staff_id ( full_name )")
    .eq("run_id", runId);
  if (error) throw error;
  return (data || [])
    .map(({ staff, ...l }) => ({
      ...l,
      full_name: staff?.full_name || "Former staff",
      hourly_rate: l.hourly_rate != null ? Number(l.hourly_rate) : null,
      ...Object.fromEntries(["regular_hours", "overtime_hours", "regular_pay", "overtime_pay", "tips", "reimbursements", "total"].map((k) => [k, Number(l[k])])),
      warnings: [],
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

const sumLines = (lines) => {
  const c = (k) => Math.round(lines.reduce((t, l) => t + Math.round(Number(l[k]) * 100), 0)) / 100;
  return {
    hours: Math.round(lines.reduce((t, l) => t + Number(l.regular_hours) + Number(l.overtime_hours), 0) * 100) / 100,
    wages: Math.round((c("regular_pay") + c("overtime_pay")) * 100) / 100,
    tips: c("tips"),
    reimbursements: c("reimbursements"),
    total: c("total"),
  };
};

/**
 * Weekly payroll (owner / manager).
 * GET ?week=YYYY-MM-DD[&format=csv] → the week's run: live numbers while draft, frozen once
 *     approved/paid; plus recent runs.
 * POST { action: "approve", week } → freezes the numbers and reserves the pay-backs
 * POST { action: "reopen", week }  → back to draft (approved runs only)
 * POST { action: "paid", week, payment_method } → locks the run; pay-backs marked reimbursed
 *
 * Hierarchy: a manager approves employees' pay. When the week also has a manager's (or the
 * owner's) pay, the manager's approve is a sign-off on the crew (crew_approved_*) and the
 * owner finishes the approval; only the owner can reopen such a week.
 */
export default async function handler(req, res) {
  let actor;
  try {
    ({ admin: actor } = await verifyAdmin(req));
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const who = actor.name ? `${actor.name} (${actor.id})` : actor.id;

  try {
    const sb = serviceClient();
    const body = req.method === "POST" ? parseBody(req) : {};
    const weekArg = req.query?.week || body.week;
    // Default to the most recent finished week — that's the one you pay.
    const week = payWeek(isIsoDate(weekArg) ? weekArg : lastWeek());

    const [{ data: run, error: runErr }, { data: staffRows, error: stErr }] = await Promise.all([
      sb.from("payroll_runs").select(RUN_COLS).eq("week_start", week.weekStart).maybeSingle(),
      sb.from("staff").select("id, role"),
    ]);
    if (runErr) throw runErr;
    if (stErr) throw stErr;
    const roleOf = new Map((staffRows || []).map((s) => [s.id, s.role]));
    const isOwner = actor.role === "owner";
    // True when any line is someone the actor can't approve pay for (a manager or the owner).
    const needsOwner = (lines) => lines.some((l) => roleOf.get(l.staff_id) !== "employee");

    const current = async () => {
      if (run && run.status !== "draft") {
        const lines = await frozenLines(sb, run.id);
        return { lines, unassigned_tips: [], totals: sumLines(lines), live: false };
      }
      const r = await loadPayroll(sb, week, { excludeRunId: run?.id || null });
      return { ...r, live: true };
    };

    if (req.method === "GET") {
      const result = await current();
      if (req.query?.format === "csv") {
        const csv = payrollCsv({ week_start: week.weekStart, week_end: week.weekEnd, status: run?.status || "draft" }, result.lines);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="payroll-${week.weekStart}.csv"`);
        return res.status(200).send(csv);
      }
      const { data: recent, error: recErr } = await sb.from("payroll_runs").select(RUN_COLS).order("week_start", { ascending: false }).limit(8);
      if (recErr) throw recErr;
      const ownerNeeded = needsOwner(result.lines);
      return res.status(200).json({
        week: { start: week.weekStart, end: week.weekEnd },
        this_week: payWeek(todayNY()).weekStart,
        run: run || { status: "draft", week_start: week.weekStart, week_end: week.weekEnd },
        ...result,
        lines: result.lines.map((l) => ({ ...l, role: roleOf.get(l.staff_id) || null })),
        needs_owner: ownerNeeded,
        can_finish: isOwner || !ownerNeeded,
        payment_methods: METHODS,
        recent: recent || [],
      });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const now = new Date().toISOString();

    if (body.action === "approve") {
      if (run && run.status !== "draft") return res.status(409).json({ error: `This week is already ${run.status}` });
      if (week.weekStart >= payWeek(todayNY()).weekStart) return res.status(400).json({ error: "You can approve a week once it's over" });
      const result = await loadPayroll(sb, week, { excludeRunId: run?.id || null });
      const blocking = result.lines.filter((l) => l.warnings.some((w) => /Still clocked in/.test(w)));
      if (blocking.length) {
        return res.status(409).json({ error: `Fix open clock-ins first: ${blocking.map((l) => l.full_name).join(", ")}` });
      }

      // A manager signs off the crew; weeks with a manager's pay are finished by the owner.
      if (!isOwner && needsOwner(result.lines)) {
        if (run?.crew_approved_at) return res.status(409).json({ error: "You've already signed off the crew; the owner approves the managers' pay" });
        if (run) {
          const { error } = await sb.from("payroll_runs").update({ crew_approved_by: who, crew_approved_at: now, updated_at: now }).eq("id", run.id).eq("status", "draft");
          if (error) throw error;
        } else {
          const { error } = await sb
            .from("payroll_runs")
            .insert({ week_start: week.weekStart, week_end: week.weekEnd, status: "draft", crew_approved_by: who, crew_approved_at: now });
          if (error) {
            if (error.code === "23505") return res.status(409).json({ error: "Someone else just saved this week; refresh" });
            throw error;
          }
        }
        return res.status(200).json({ ok: true, status: "draft", crew_approved: true });
      }

      let runId = run?.id;
      if (runId) {
        const { error } = await sb.from("payroll_runs").update({ status: "approved", approved_by: who, approved_at: now, updated_at: now }).eq("id", runId).eq("status", "draft");
        if (error) throw error;
      } else {
        const { data, error } = await sb
          .from("payroll_runs")
          .insert({ week_start: week.weekStart, week_end: week.weekEnd, status: "approved", approved_by: who, approved_at: now })
          .select("id")
          .single();
        if (error) {
          if (error.code === "23505") return res.status(409).json({ error: "Someone else just saved this week; refresh" });
          throw error;
        }
        runId = data.id;
      }
      await sb.from("payroll_lines").delete().eq("run_id", runId);
      if (result.lines.length) {
        const { error } = await sb.from("payroll_lines").insert(
          result.lines.map((l) => ({
            run_id: runId,
            staff_id: l.staff_id,
            hourly_rate: l.hourly_rate,
            regular_hours: l.regular_hours,
            overtime_hours: l.overtime_hours,
            regular_pay: l.regular_pay,
            overtime_pay: l.overtime_pay,
            tips: l.tips,
            reimbursements: l.reimbursements,
            total: l.total,
            details: l.details,
          }))
        );
        if (error) throw error;
      }
      const expenseIds = result.lines.flatMap((l) => l.details.expense_ids);
      if (expenseIds.length) {
        const { error } = await sb.from("expenses").update({ payroll_run_id: runId }).in("id", expenseIds).is("payroll_run_id", null);
        if (error) throw error;
      }
      return res.status(200).json({ ok: true, status: "approved" });
    }

    if (body.action === "reopen") {
      if (!run || run.status !== "approved") return res.status(409).json({ error: "Only an approved, unpaid week can be reopened" });
      if (!isOwner && needsOwner(await frozenLines(sb, run.id))) {
        return res.status(403).json({ error: "This week includes a manager's pay; only the owner can reopen it" });
      }
      const { error } = await sb
        .from("payroll_runs")
        .update({ status: "draft", approved_by: null, approved_at: null, crew_approved_by: null, crew_approved_at: null, updated_at: now })
        .eq("id", run.id)
        .eq("status", "approved");
      if (error) throw error;
      await sb.from("payroll_lines").delete().eq("run_id", run.id);
      await sb.from("expenses").update({ payroll_run_id: null }).eq("payroll_run_id", run.id).is("reimbursed_at", null);
      return res.status(200).json({ ok: true, status: "draft" });
    }

    if (body.action === "paid") {
      if (!run || run.status !== "approved") return res.status(409).json({ error: "Approve the week before marking it paid" });
      const method = METHODS.includes(body.payment_method) ? body.payment_method : null;
      if (!method) return res.status(400).json({ error: "Pick how the crew was paid" });
      const { error } = await sb.from("payroll_runs").update({ status: "paid", paid_by: who, paid_at: now, updated_at: now }).eq("id", run.id).eq("status", "approved");
      if (error) throw error;
      await sb.from("payroll_lines").update({ payment_method: method }).eq("run_id", run.id);
      await sb.from("expenses").update({ reimbursed_at: now }).eq("payroll_run_id", run.id).is("reimbursed_at", null);
      return res.status(200).json({ ok: true, status: "paid" });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("admin-payroll error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

function lastWeek() {
  const thisMonday = payWeek(todayNY()).weekStart;
  const d = new Date(thisMonday + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}
