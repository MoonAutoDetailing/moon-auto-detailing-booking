import { createClient } from "@supabase/supabase-js";
import { rateLimit } from "./_rateLimit.js";
import { sendSubscriptionAccessLinkEmailCore } from "../lib/email/sendSubscriptionAccessLinkEmail.js";

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
 * Used for deterministic match with stored phone (may be formatted).
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
 * Email: case-insensitive ilike (exact, escaped). Phone: normalized digits compared in code.
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
 * Find a recoverable subscription for the given customer_id(s).
 * Rule: 1) prefer status != 'cancelled', 2) require valid activation_booking_id,
 * 3) require linked booking with manage_token, 4) newest created_at.
 * Returns { subscription, manageToken } or null.
 */
async function findRecoverableSubscriptionForCustomers(supabase, customerIds) {
  if (!customerIds?.length) return null;

  const { data: subscriptions, error: subErr } = await supabase
    .from("subscriptions")
    .select("id, status, activation_booking_id, created_at")
    .in("customer_id", customerIds)
    .order("created_at", { ascending: false });

  if (subErr || !subscriptions?.length) return null;

  const sorted = [...subscriptions].sort((a, b) => {
    const aCancelled = a.status === "cancelled" ? 1 : 0;
    const bCancelled = b.status === "cancelled" ? 1 : 0;
    if (aCancelled !== bCancelled) return aCancelled - bCancelled;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  for (const sub of sorted) {
    if (!sub.activation_booking_id) continue;
    const { data: booking, error: bookErr } = await supabase
      .from("bookings")
      .select("id, manage_token")
      .eq("id", sub.activation_booking_id)
      .maybeSingle();
    if (bookErr || !booking?.manage_token) continue;
    return { subscription: sub, manageToken: booking.manage_token };
  }
  console.warn("[request-subscription-access] customer match but no recoverable subscription (missing activation_booking_id or manage_token)");
  return null;
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
    key: "request-subscription-access",
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

    const recovered = await findRecoverableSubscriptionForCustomers(
      supabase,
      await findMatchingCustomerIds(supabase, normalizedEmail, normalizedPhone)
    );

    if (recovered) {
      const { subscription, manageToken } = recovered;
      try {
        const { data: subWithCustomer } = await supabase
          .from("subscriptions")
          .select("customers:customer_id(email)")
          .eq("id", subscription.id)
          .maybeSingle();
        const customerEmail = subWithCustomer?.customers?.email;
        const toEmail = customerEmail || normalizedEmail;
        await sendSubscriptionAccessLinkEmailCore(toEmail, manageToken, subscription.id);
      } catch (err) {
        console.warn("[request-subscription-access] send failed:", err?.message || err);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("request-subscription-access error:", err);
    return res.status(200).json({ ok: true });
  }
}
