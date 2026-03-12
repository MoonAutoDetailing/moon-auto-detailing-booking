import { createClient } from "@supabase/supabase-js";
import { rateLimit } from "./_rateLimit.js";
import { sendBookingAccessLinkEmailCore } from "../lib/email/sendBookingAccessLinkEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Strip non-digits; normalize US leading 1 to 10-digit canonical.
 */
function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.charAt(0) === "1") {
    return digits.slice(1);
  }
  return digits;
}

/** Escape for Postgres ilike exact match (%, _, \ are special). */
function escapeIlike(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Find customer_id(s) matching normalized email + phone.
 */
async function findMatchingCustomerIds(supabase, normalizedEmail, normalizedPhone) {
  const escaped = escapeIlike(normalizedEmail);
  const { data: customers, error } = await supabase
    .from("customers")
    .select("id, email, phone")
    .ilike("email", escaped);

  if (error || !customers?.length) return [];
  const ids = customers
    .filter((c) => normalizePhone(c.phone) === normalizedPhone)
    .map((c) => c.id);
  return ids;
}

/**
 * Recoverable booking rule: status = 'confirmed', has manage_token.
 * If multiple qualify, select most recent by scheduled_start DESC, then created_at DESC.
 * Excludes: pending, completed, cancelled, reschedule_requested.
 */
const RECOVERABLE_STATUS = "confirmed";

async function findRecoverableBookingForCustomers(supabase, customerIds) {
  if (!customerIds?.length) return null;

  const { data: bookings, error } = await supabase
    .from("bookings")
    .select("id, customer_id, manage_token, scheduled_start, created_at")
    .in("customer_id", customerIds)
    .eq("status", RECOVERABLE_STATUS)
    .not("manage_token", "is", null)
    .order("scheduled_start", { ascending: false });

  if (error || !bookings?.length) return null;

  // scheduled_start can be null; tie-break by created_at DESC
  const sorted = [...bookings].sort((a, b) => {
    const aStart = a.scheduled_start ? new Date(a.scheduled_start).getTime() : 0;
    const bStart = b.scheduled_start ? new Date(b.scheduled_start).getTime() : 0;
    if (aStart !== bStart) return bStart - aStart;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });

  const chosen = sorted[0];
  if (!chosen?.manage_token) return null;
  return { id: chosen.id, customerId: chosen.customer_id, manageToken: chosen.manage_token };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rl = rateLimit(req, {
    key: "request-booking-access",
    limit: 5,
    windowMs: 15 * 60 * 1000
  });
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSeconds));
    return res.status(429).json({
      ok: true,
      message: "Too many attempts. Please try again in a few minutes."
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const emailRaw = body.email;
    const phoneRaw = body.phone;
    const normalizedEmail = normalizeEmail(emailRaw);
    const normalizedPhone = normalizePhone(phoneRaw);

    if (!normalizedEmail || !normalizedPhone) {
      return res.status(200).json({ ok: true });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const recovered = await findRecoverableBookingForCustomers(
      supabase,
      await findMatchingCustomerIds(supabase, normalizedEmail, normalizedPhone)
    );

    if (recovered) {
      let toEmail = normalizedEmail;
      if (recovered.customerId) {
        const { data: customer } = await supabase
          .from("customers")
          .select("email")
          .eq("id", recovered.customerId)
          .maybeSingle();
        const resolvedEmail = customer?.email && String(customer.email).trim();
        if (resolvedEmail) toEmail = resolvedEmail.toLowerCase();
      }
      try {
        await sendBookingAccessLinkEmailCore(
          toEmail,
          recovered.manageToken,
          recovered.id
        );
      } catch (err) {
        console.warn("[request-booking-access] send failed:", err?.message || err);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("request-booking-access error:", err);
    return res.status(200).json({ ok: true });
  }
}
