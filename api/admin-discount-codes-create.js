import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { normalizeDiscountCode } from "./_discountCode.js";
import { parseAdminDatetimeAsNewYork } from "../lib/discountAdminDate.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** POST: create discount code. Body: code, percent_off, starts_at, ends_at. */
export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const codeRaw = body.code;
    const percentOff = body.percent_off != null ? Number(body.percent_off) : NaN;
    const startsAt = body.starts_at;
    const endsAt = body.ends_at;

    const code = String(codeRaw ?? "").trim();
    if (!code) {
      return res.status(400).json({ error: "Code is required." });
    }
    if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 100) {
      return res.status(400).json({ error: "Percent off must be a number between 0 and 100." });
    }
    if (!startsAt || !endsAt) {
      return res.status(400).json({ error: "Both starts_at and ends_at are required." });
    }
    const startResult = parseAdminDatetimeAsNewYork(startsAt);
    const endResult = parseAdminDatetimeAsNewYork(endsAt);
    if (!startResult.ok) {
      return res.status(400).json({ error: "starts_at: " + (startResult.error || "Invalid format.") });
    }
    if (!endResult.ok) {
      return res.status(400).json({ error: "ends_at: " + (endResult.error || "Invalid format.") });
    }
    const startsAtIso = startResult.iso;
    const endsAtIso = endResult.iso;
    if (startsAtIso >= endsAtIso) {
      return res.status(400).json({ error: "starts_at must be before ends_at." });
    }

    const code_normalized = normalizeDiscountCode(code);
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: existing } = await supabase
      .from("discount_codes")
      .select("id")
      .eq("code_normalized", code_normalized)
      .maybeSingle();
    if (existing) {
      return res.status(400).json({ error: "A discount code with this value already exists (codes are unique)." });
    }

    const { data: row, error } = await supabase
      .from("discount_codes")
      .insert({
        code,
        code_normalized,
        percent_off: percentOff,
        starts_at: startsAtIso,
        ends_at: endsAtIso,
        is_disabled: false
      })
      .select("id, code, percent_off, starts_at, ends_at")
      .single();

    if (error) {
      if (error.code === "23505") return res.status(400).json({ error: "A discount code with this value already exists." });
      throw error;
    }
    return res.status(200).json({ ok: true, discount_code: row });
  } catch (err) {
    console.error("admin-discount-codes-create error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
