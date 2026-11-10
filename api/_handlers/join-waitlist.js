import { createClient } from "@supabase/supabase-js";
import { rateLimit } from "../_rateLimit.js";
import { sendBookingEmail } from "../_sendEmail.js";

const ADMIN_EMAIL = "moonautodetailing@gmail.com";
const INTERESTS = ["maintenance_plan", "one_time_detail"];
const SOURCES = ["booking_page", "maintenance_page"];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function clean(value, max) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** POST: { full_name, email, phone, interest, preferred_plan, vehicle, notes, source } */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  const rl = rateLimit(req, { key: "join-waitlist", limit: 5, windowMs: 15 * 60 * 1000 });
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSeconds));
    return res.status(429).json({ ok: false, message: "Too many attempts. Please try again in a few minutes." });
  }

  const body = req.body || {};
  const row = {
    full_name: clean(body.full_name, 120),
    email: clean(body.email, 200),
    phone: clean(body.phone, 40),
    interest: INTERESTS.includes(body.interest) ? body.interest : "maintenance_plan",
    preferred_plan: clean(body.preferred_plan, 60),
    vehicle: clean(body.vehicle, 120),
    notes: clean(body.notes, 1000),
    source: SOURCES.includes(body.source) ? body.source : "booking_page"
  };

  if (!row.full_name) {
    return res.status(400).json({ ok: false, message: "Please enter your name." });
  }
  if (!row.email && !row.phone) {
    return res.status(400).json({ ok: false, message: "Please enter an email or phone number so we can reach you." });
  }
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
    return res.status(400).json({ ok: false, message: "Please enter a valid email address." });
  }

  try {
    const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
    const { error } = await supabase.from("waitlist").insert(row);
    if (error) throw error;
  } catch (err) {
    console.error("join-waitlist error:", err);
    return res.status(500).json({ ok: false, message: "Could not join the waitlist. Please try again." });
  }

  try {
    const interestLabel = row.interest === "one_time_detail" ? "One-time detail" : "Maintenance Program";
    await sendBookingEmail({
      to: ADMIN_EMAIL,
      subject: `New waitlist sign-up: ${row.full_name}`,
      html: `
        <p><strong>${escapeHtml(row.full_name)}</strong> joined the waitlist.</p>
        <p>Interest: ${escapeHtml(interestLabel)}${row.preferred_plan ? ` (${escapeHtml(row.preferred_plan)})` : ""}</p>
        <p>Email: ${escapeHtml(row.email || "—")}<br/>Phone: ${escapeHtml(row.phone || "—")}</p>
        <p>Vehicle: ${escapeHtml(row.vehicle || "—")}</p>
        <p>Notes: ${escapeHtml(row.notes || "—")}</p>
      `
    });
  } catch (emailErr) {
    console.error("[EMAIL] type=admin-waitlist-alert status=failure", emailErr);
  }

  return res.status(200).json({ ok: true });
}
