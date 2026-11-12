import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient, parseBody } from "../_staffAuth.js";
import { PHOTO_BUCKET, isIsoDate } from "../_jobs.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { payWeek } from "../_timeclock.js";
import { addDays } from "../_schedule.js";
import { rejectBlocked } from "../_expenses.js";

const COLS =
  "id, expense_date, vendor, category, expense_type, description, amount, payment_method, reimburse, reimbursed_at, payroll_run_id, receipt_path, status, review_note, reviewed_by, submitted_by_staff_id, owner_reviewed_at, created_at";

const cents = (n) => Math.round(Number(n || 0) * 100);

/**
 * Weekly expense report (owner only — guarded in router.js). Covers every expense entered
 * Monday–Sunday (New York): crew receipts managers approved, managers' own and the owner's.
 * GET ?week=YYYY-MM-DD → { week, report, expenses, totals } (defaults to last week)
 * POST { action: "review", id, status: "approved"|"rejected", note? } → owner decision on one item
 * POST { action: "approve", week } → signs off the week (nothing may still be pending)
 */
export default async function handler(req, res) {
  let actor;
  try {
    ({ admin: actor } = await verifyAdmin(req));
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (actor.role !== "owner") return res.status(403).json({ error: "Only the owner approves the weekly expense report" });
  const who = actor.name ? `${actor.name} (${actor.id})` : actor.id;

  try {
    const sb = serviceClient();
    const body = req.method === "POST" ? parseBody(req) : {};
    const weekArg = req.query?.week || body.week;
    const week = payWeek(isIsoDate(weekArg) ? weekArg : addDays(payWeek(todayNY()).weekStart, -7));

    const loadWeek = async () => {
      const [{ data, error }, { data: staff, error: sErr }, { data: report, error: rErr }] = await Promise.all([
        sb.from("expenses").select(COLS).gte("created_at", week.startISO).lt("created_at", week.endISO).order("created_at"),
        sb.from("staff").select("id, full_name, role"),
        sb.from("expense_reports").select("*").eq("week_start", week.weekStart).maybeSingle(),
      ]);
      for (const e of [error, sErr, rErr]) if (e) throw e;
      return { rows: data || [], staff: new Map((staff || []).map((s) => [s.id, s])), report: report || null };
    };

    if (req.method === "GET") {
      const { rows, staff, report } = await loadWeek();
      const paths = rows.map((r) => r.receipt_path).filter(Boolean);
      let urls = new Map();
      if (paths.length) {
        const { data: signed, error: uErr } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
        if (uErr) throw uErr;
        urls = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
      }
      const counted = rows.filter((r) => r.status !== "rejected");
      return res.status(200).json({
        week: { start: week.weekStart, end: week.weekEnd },
        this_week: payWeek(todayNY()).weekStart,
        report,
        expenses: rows.map(({ receipt_path, ...r }) => {
          const by = staff.get(r.submitted_by_staff_id);
          return {
            ...r,
            receipt_url: urls.get(receipt_path) || null,
            submitted_by: by?.full_name || "Owner / admin",
            submitted_role: by?.role || null,
            locked: rejectBlocked(r),
          };
        }),
        totals: {
          count: counted.length,
          amount: counted.reduce((t, r) => t + cents(r.amount), 0) / 100,
          pending: rows.filter((r) => r.status === "pending").length,
          rejected: rows.filter((r) => r.status === "rejected").length,
          paybacks: counted.filter((r) => r.reimburse).reduce((t, r) => t + cents(r.amount), 0) / 100,
        },
      });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const now = new Date().toISOString();

    if (body.action === "review") {
      if (!body.id || !["approved", "rejected"].includes(body.status)) return res.status(400).json({ error: "Choose approve or reject" });
      const { data: existing, error } = await sb.from("expenses").select(COLS).eq("id", body.id).maybeSingle();
      if (error) throw error;
      if (!existing) return res.status(404).json({ error: "Expense not found" });
      if (body.status === "rejected") {
        const blocked = rejectBlocked(existing);
        if (blocked) return res.status(409).json({ error: blocked });
      }
      const update = { status: body.status, owner_reviewed_at: now, owner_reviewed_by: who };
      if (existing.status === "pending" || body.status !== existing.status) {
        update.reviewed_at = now;
        update.reviewed_by = who;
      }
      if (body.note !== undefined) update.review_note = body.note ? String(body.note).slice(0, 300) : null;
      const { data, error: upErr } = await sb.from("expenses").update(update).eq("id", existing.id).select("id, status").single();
      if (upErr) throw upErr;
      return res.status(200).json({ expense: data });
    }

    if (body.action === "approve") {
      if (week.weekStart >= payWeek(todayNY()).weekStart) return res.status(400).json({ error: "You can approve a week's report once the week is over" });
      const { rows, report } = await loadWeek();
      if (report) return res.status(409).json({ error: "This week's report is already approved" });
      const pending = rows.filter((r) => r.status === "pending").length;
      if (pending) return res.status(409).json({ error: `Approve or reject the ${pending} pending expense${pending === 1 ? "" : "s"} first` });
      const counted = rows.filter((r) => r.status !== "rejected");
      const { error: insErr } = await sb.from("expense_reports").insert({
        week_start: week.weekStart,
        week_end: week.weekEnd,
        expense_count: counted.length,
        total: counted.reduce((t, r) => t + cents(r.amount), 0) / 100,
        approved_by: who,
        approved_at: now,
      });
      if (insErr) {
        if (insErr.code === "23505") return res.status(409).json({ error: "This week's report is already approved" });
        throw insErr;
      }
      const unstamped = counted.filter((r) => !r.owner_reviewed_at).map((r) => r.id);
      if (unstamped.length) {
        const { error: stErr } = await sb.from("expenses").update({ owner_reviewed_at: now, owner_reviewed_by: who }).in("id", unstamped);
        if (stErr) throw stErr;
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("admin-expense-report error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
