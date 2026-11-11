// Morning crew email: everyone with a published shift today gets the day's jobs.
// Runs inside the 11:00 UTC reminders cron (6–7am New York). Each shift is emailed at most
// once; the stamp is written only after a successful send, so a failure retries next run.

import { nyDayRange } from "./_jobs.js";

const nyTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

export async function runCrewMorningEmails({ sb, today, send }) {
  const { data: shifts, error } = await sb
    .from("shifts")
    .select("id, staff_id, shift_date, start_time, end_time")
    .eq("shift_date", today)
    .eq("published", true)
    .is("morning_email_sent_at", null);
  if (error) throw error;
  if (!shifts?.length) return { sent: 0, failed: 0 };

  const { startISO, endISO } = nyDayRange(today);
  const [{ data: staff, error: sErr }, { data: jobs, error: jErr }] = await Promise.all([
    sb.from("staff").select("id, full_name, email, active").in("id", [...new Set(shifts.map((s) => s.staff_id))]),
    sb
      .from("bookings")
      .select("scheduled_start, service_address, job_flag, service_variants:service_variant_id ( services:service_id ( category, level ) )")
      .eq("status", "confirmed")
      .gte("scheduled_start", startISO)
      .lt("scheduled_start", endISO)
      .order("scheduled_start"),
  ]);
  if (sErr) throw sErr;
  if (jErr) throw jErr;

  const dayJobs = (jobs || []).map((j) => ({
    time: nyTime(j.scheduled_start),
    address: j.service_address,
    job_flag: j.job_flag,
    service: j.service_variants?.services ? `${j.service_variants.services.category} (Level ${j.service_variants.services.level})` : "Detail",
  }));

  let sent = 0;
  let failed = 0;
  for (const shift of shifts) {
    const person = (staff || []).find((p) => p.id === shift.staff_id);
    if (!person?.active || !person.email) continue;
    const r = await send(person, shift, dayJobs);
    if (!r?.success) {
      failed++;
      console.error("[CREW_MORNING] send failed", person.id, r?.error);
      continue;
    }
    await sb.from("shifts").update({ morning_email_sent_at: new Date().toISOString() }).eq("id", shift.id);
    sent++;
  }
  return { sent, failed };
}
