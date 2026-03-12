import { createClient } from "@supabase/supabase-js";
import { rateLimit } from "./_rateLimit.js";
import { getActiveDiscountCode, normalizeDiscountCode } from "./_discountCode.js";
import { applyDiscountToPricing } from "../lib/discount.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * POST: { code, base_price, travel_fee, subscription_mode }.
 * Returns preview-safe pricing; does not trust client discount amount or total.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const rl = rateLimit(req, {
    key: "validate-discount-code",
    limit: 30,
    windowMs: 60 * 1000
  });
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSeconds));
    return res.status(429).json({ valid: false, reason: "too_many_attempts" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const codeRaw = body.code;
    const basePrice = Number(body.base_price);
    const travelFee = Number(body.travel_fee);
    const subscriptionMode = body.subscription_mode === true || body.subscription_mode === "1";

    if (subscriptionMode) {
      return res.status(200).json({ valid: false, reason: "not_applicable_subscription" });
    }

    const codeTrimmed = String(codeRaw || "").trim();
    if (!codeTrimmed) {
      return res.status(200).json({ valid: false, reason: "empty" });
    }

    const codeNormalized = normalizeDiscountCode(codeRaw);
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );
    const discount = await getActiveDiscountCode(supabase, codeNormalized);

    if (!discount) {
      return res.status(200).json({
        valid: false,
        reason: "invalid_or_expired"
      });
    }

    if (!Number.isFinite(basePrice) || basePrice < 0 || !Number.isFinite(travelFee) || travelFee < 0) {
      return res.status(200).json({ valid: false, reason: "invalid_inputs" });
    }

    const { base_price, travel_fee, discount_amount, total_price } = applyDiscountToPricing(
      basePrice,
      travelFee,
      discount.percent_off
    );

    return res.status(200).json({
      valid: true,
      discount_code: discount.code,
      discount_percent: discount.percent_off,
      discount_amount,
      base_price,
      travel_fee,
      total_price
    });
  } catch (err) {
    console.error("validate-discount-code error:", err);
    return res.status(200).json({ valid: false, reason: "error" });
  }
}
