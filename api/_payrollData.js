// Loads everything payroll needs for one pay week and runs the calculator.
// Shared by admin-payroll (all staff) and staff-pay (one person).

import { computePayroll } from "./_payroll.js";

const TEST_NOTE = /^\s*TEST ACCOUNT/i; // owner's QA bookings never count

export async function loadPayroll(sb, week, { staffId = null, now = new Date(), excludeRunId = null } = {}) {
  let entriesQ = sb
    .from("time_entries")
    .select("id, staff_id, clock_in_at, clock_out_at, verify_method, voided_at")
    .is("voided_at", null)
    .gte("clock_in_at", new Date(Date.parse(week.startISO) - 24 * 3600000).toISOString())
    .lt("clock_in_at", week.endISO);
  let reimbQ = sb
    .from("expenses")
    .select("id, submitted_by_staff_id, amount, payroll_run_id")
    .eq("status", "approved")
    .eq("reimburse", true)
    .is("reimbursed_at", null)
    .lte("expense_date", week.weekEnd)
    .not("submitted_by_staff_id", "is", null);
  if (staffId) {
    entriesQ = entriesQ.eq("staff_id", staffId);
    reimbQ = reimbQ.eq("submitted_by_staff_id", staffId);
  }

  const [{ data: staff, error: sErr }, { data: entries, error: eErr }, { data: jobs, error: jErr }, { data: reimb, error: rErr }] =
    await Promise.all([
      sb.from("staff").select("id, full_name, hourly_rate, role, active"),
      entriesQ,
      sb
        .from("bookings")
        .select("id, customer_notes, job_payments ( tip_amount ), booking_staff ( staff_id )")
        .eq("status", "completed")
        .gte("scheduled_start", week.startISO)
        .lt("scheduled_start", week.endISO),
      reimbQ,
    ]);
  for (const e of [sErr, eErr, jErr, rErr]) if (e) throw e;

  // Pay-backs already claimed by another week's approved run aren't counted again.
  const reimbursements = (reimb || [])
    .filter((r) => !r.payroll_run_id || r.payroll_run_id === excludeRunId)
    .map((r) => ({ id: r.id, staff_id: r.submitted_by_staff_id, amount: r.amount }));

  const inWeek = (entries || []).filter((e) => !e.clock_out_at || Date.parse(e.clock_out_at) > Date.parse(week.startISO));
  let tipJobs = (jobs || [])
    .filter((b) => !TEST_NOTE.test(b.customer_notes || ""))
    .map((b) => ({
      booking_id: b.id,
      tip: (b.job_payments || []).reduce((t, p) => t + Number(p.tip_amount || 0), 0),
      staff_ids: (b.booking_staff || []).map((x) => x.staff_id),
    }));
  if (staffId) tipJobs = tipJobs.filter((j) => j.staff_ids.includes(staffId));

  return computePayroll({ week, staff: staff || [], entries: inWeek, tipJobs, reimbursements, now });
}
