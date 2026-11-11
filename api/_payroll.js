// Weekly payroll math. Pure: the handler loads the week's data and passes it in.
//
// Pay per person = hourly rate × regular hours + rate × overtime multiplier × overtime hours
//                + tips (each job's tip split evenly between the people who worked it)
//                + pay-backs (approved own-money expenses not yet reimbursed).
// Money is handled in cents so splits and totals always add up exactly.

import { summarizeWeek, clockSettings } from "./_timeclock.js";

const cents = (n) => Math.round(Number(n || 0) * 100);
const dollars = (c) => Math.round(c) / 100;

/** Splits `totalCents` evenly; leftover cents go to the first people in the list. */
export function splitCents(totalCents, n) {
  if (n <= 0) return [];
  const base = Math.floor(totalCents / n);
  const extra = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * @param week        payWeek() result
 * @param staff       [{ id, full_name, hourly_rate, active }]
 * @param entries     time_entries rows (voided ones are ignored)
 * @param tipJobs     [{ booking_id, tip, staff_ids: [...] }] completed jobs in the week
 * @param reimbursements [{ id, staff_id, amount }]
 * @returns { lines, unassigned_tips, totals }
 */
export function computePayroll({ week, staff, entries = [], tipJobs = [], reimbursements = [], settings = clockSettings(), now = new Date() }) {
  const byStaff = new Map();
  const line = (id) => {
    if (!byStaff.has(id)) byStaff.set(id, { hoursEntries: [], tipCents: 0, tipJobs: [], reimbCents: 0, expenseIds: [] });
    return byStaff.get(id);
  };

  for (const e of entries) if (!e.voided_at) line(e.staff_id).hoursEntries.push(e);

  const unassigned = [];
  for (const j of tipJobs) {
    const tip = cents(j.tip);
    if (tip <= 0) continue;
    const people = [...new Set(j.staff_ids || [])].sort();
    if (!people.length) {
      unassigned.push({ booking_id: j.booking_id, tip: dollars(tip) });
      continue;
    }
    splitCents(tip, people.length).forEach((share, i) => {
      const l = line(people[i]);
      l.tipCents += share;
      l.tipJobs.push({ booking_id: j.booking_id, share: dollars(share) });
    });
  }

  for (const r of reimbursements) {
    const l = line(r.staff_id);
    l.reimbCents += cents(r.amount);
    l.expenseIds.push(r.id);
  }

  const names = new Map(staff.map((s) => [s.id, s]));
  const lines = [...byStaff.entries()].map(([staffId, l]) => {
    const person = names.get(staffId) || { full_name: "Former staff", hourly_rate: null };
    const summary = summarizeWeek(l.hoursEntries, week, { now, settings });
    const rate = person.hourly_rate != null ? Number(person.hourly_rate) : null;
    const regularPayC = rate != null ? Math.round(rate * summary.regularHours * 100) : 0;
    const overtimePayC = rate != null ? Math.round(rate * settings.overtimeMultiplier * summary.overtimeHours * 100) : 0;
    const warnings = [];
    if (summary.hours > 0 && rate == null) warnings.push("No hourly rate set — hours aren't paid until you add one under Team");
    if (summary.open) warnings.push("Still clocked in — clock them out or fix the entry before approving");
    for (const f of summary.flags) if (f.type === "forgot_clock_out" || f.type === "long_shift") warnings.push(f.message);
    return {
      staff_id: staffId,
      full_name: person.full_name,
      hourly_rate: rate,
      regular_hours: summary.regularHours,
      overtime_hours: summary.overtimeHours,
      regular_pay: dollars(regularPayC),
      overtime_pay: dollars(overtimePayC),
      tips: dollars(l.tipCents),
      reimbursements: dollars(l.reimbCents),
      total: dollars(regularPayC + overtimePayC + l.tipCents + l.reimbCents),
      details: {
        entry_ids: l.hoursEntries.map((e) => e.id),
        tip_jobs: l.tipJobs,
        expense_ids: l.expenseIds,
      },
      warnings: [...new Set(warnings)],
    };
  });

  lines.sort((a, b) => a.full_name.localeCompare(b.full_name));
  const sum = (k) => dollars(lines.reduce((t, l) => t + cents(l[k]), 0));
  return {
    lines,
    unassigned_tips: unassigned,
    totals: {
      hours: Math.round(lines.reduce((t, l) => t + l.regular_hours + l.overtime_hours, 0) * 100) / 100,
      wages: dollars(lines.reduce((t, l) => t + cents(l.regular_pay) + cents(l.overtime_pay), 0)),
      tips: sum("tips"),
      reimbursements: sum("reimbursements"),
      total: sum("total"),
    },
  };
}

/** CSV for the accountant / payroll service. */
export function payrollCsv(run, lines) {
  const cols = ["Week start", "Week end", "Name", "Rate", "Regular hours", "Overtime hours", "Regular pay", "Overtime pay", "Tips", "Pay-backs", "Total", "Status"];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = lines.map((l) => [
    run.week_start, run.week_end, l.full_name, l.hourly_rate ?? "", l.regular_hours, l.overtime_hours,
    l.regular_pay.toFixed(2), l.overtime_pay.toFixed(2), l.tips.toFixed(2), l.reimbursements.toFixed(2), l.total.toFixed(2), run.status,
  ]);
  return [cols, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}

/**
 * Business summary for a period. jobs: completed jobs with amount_collected/tip;
 * expenses: approved expenses; laborCost: wages paid or estimated for the period.
 * Owner draws/contributions and liability payments aren't costs; asset purchases are
 * shown separately.
 */
export function summarizeBusiness({ jobs = [], expenses = [], laborCost = 0, hours = 0 }) {
  const revenueC = jobs.reduce((t, j) => t + cents(j.amount_collected), 0);
  const tipsC = jobs.reduce((t, j) => t + cents(j.tip_amount), 0);
  const costTypes = ["Direct Cost", "Operating Expense"];
  const expC = expenses.filter((e) => costTypes.includes(e.expense_type)).reduce((t, e) => t + cents(e.amount), 0);
  const assetsC = expenses.filter((e) => e.expense_type === "Asset Purchase").reduce((t, e) => t + cents(e.amount), 0);
  const laborC = cents(laborCost);
  const profitC = revenueC - expC - laborC;
  return {
    revenue: dollars(revenueC),
    tips: dollars(tipsC),
    jobs: jobs.length,
    average_ticket: jobs.length ? dollars(Math.round(revenueC / jobs.length)) : 0,
    expenses: dollars(expC),
    asset_purchases: dollars(assetsC),
    labor: dollars(laborC),
    profit: dollars(profitC),
    margin: revenueC ? Math.round((profitC / revenueC) * 1000) / 10 : 0,
    hours: Math.round(hours * 100) / 100,
    hours_per_job: jobs.length ? Math.round((hours / jobs.length) * 100) / 100 : 0,
  };
}
