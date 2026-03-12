import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** GET: list all discount codes. Order: active first, then scheduled, then inactive. */
export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );
    const { data: rows, error } = await supabase
      .from("discount_codes")
      .select("id, code, code_normalized, percent_off, starts_at, ends_at, is_disabled, created_at, updated_at")
      .order("starts_at", { ascending: false });

    if (error) throw error;
    const now = new Date().getTime();
    const active = [];
    const scheduled = [];
    const inactive = [];
    for (const row of rows || []) {
      const start = row.starts_at ? new Date(row.starts_at).getTime() : 0;
      const end = row.ends_at ? new Date(row.ends_at).getTime() : Infinity;
      if (row.is_disabled) {
        inactive.push(row);
      } else if (now >= start && now < end) {
        active.push(row);
      } else if (now < start) {
        scheduled.push(row);
      } else {
        inactive.push(row);
      }
    }
    return res.status(200).json({
      active,
      scheduled,
      inactive
    });
  } catch (err) {
    console.error("admin-discount-codes-list error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
