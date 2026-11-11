import { sendBookingEmail } from "../../api/_sendEmail.js";

// Emails to the crew: the published week's shifts, and a morning summary of the day's jobs.
// Links point at the crew app; nothing customer-sensitive beyond what the app shows.

const BASE = () => (process.env.PUBLIC_BASE_URL || "https://moonautodetailingbooking.com").replace(/\/$/, "");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function niceDay(d) {
  return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
}

export function niceTime(t) {
  const [h, m] = String(t).slice(0, 5).split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}${m ? ":" + String(m).padStart(2, "0") : ""}${suffix}`;
}

function layout(title, bodyHtml) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2430;">
    <h2 style="color:#4f95cf;margin:0 0 12px;">${esc(title)}</h2>
    ${bodyHtml}
    <p style="margin:20px 0 0;"><a href="${BASE()}/staff.html" style="background:#4f95cf;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold;">Open the crew app</a></p>
    <p style="color:#7a8696;font-size:12px;margin-top:18px;">Moon Auto Detailing · crew schedule</p>
  </div>`;
}

export function renderWeekEmail(staff, shifts) {
  const rows = shifts
    .map((s) => `<tr><td style="padding:6px 12px 6px 0;font-weight:bold;">${esc(niceDay(s.shift_date))}</td><td style="padding:6px 0;">${esc(niceTime(s.start_time))} – ${esc(niceTime(s.end_time))}${s.notes ? `<br><span style="color:#7a8696;">${esc(s.notes)}</span>` : ""}</td></tr>`)
    .join("");
  const first = staff.full_name?.split(" ")[0] || "there";
  return {
    subject: shifts.length === 1 ? `Your shift: ${niceDay(shifts[0].shift_date)}` : `Your schedule: ${shifts.length} shifts`,
    html: layout(`Hi ${first}, here's your schedule`, `<table style="border-collapse:collapse;font-size:15px;">${rows}</table>`),
  };
}

export function renderMorningEmail(staff, shift, jobs) {
  const first = staff.full_name?.split(" ")[0] || "there";
  const ceramic = jobs.some((j) => j.job_flag === "ceramic");
  const list = jobs.length
    ? `<ol style="padding-left:18px;font-size:15px;">${jobs
        .map((j) => `<li style="margin-bottom:8px;"><strong>${esc(j.time)}</strong> — ${esc(j.service)}${j.job_flag === "ceramic" ? " <strong style=\"color:#c98a00;\">(ceramic)</strong>" : ""}<br>${esc(j.address || "")}</li>`)
        .join("")}</ol>`
    : `<p>No jobs are booked yet for today.</p>`;
  return {
    subject: `Today: ${jobs.length} job${jobs.length === 1 ? "" : "s"} · shift ${niceTime(shift.start_time)}–${niceTime(shift.end_time)}${ceramic ? " · ceramic" : ""}`,
    html: layout(
      `Good morning ${first}`,
      `<p style="font-size:15px;">Your shift today is <strong>${esc(niceTime(shift.start_time))} – ${esc(niceTime(shift.end_time))}</strong>. Clock in from the crew app when you arrive.</p>
       ${ceramic ? `<p style="background:#fff4dc;border:1px solid #f0c060;border-radius:8px;padding:10px;"><strong>Ceramic coating today</strong> — bring the coating kit, panel prep and lights.</p>` : ""}
       ${list}`
    ),
  };
}

export async function sendWeekEmail(staff, shifts) {
  if (!staff.email || !shifts.length) return { success: false, error: "nothing to send" };
  const { subject, html } = renderWeekEmail(staff, shifts);
  return sendBookingEmail({ to: staff.email, subject, html });
}

export async function sendMorningEmail(staff, shift, jobs) {
  if (!staff.email) return { success: false, error: "no email" };
  const { subject, html } = renderMorningEmail(staff, shift, jobs);
  return sendBookingEmail({ to: staff.email, subject, html });
}
