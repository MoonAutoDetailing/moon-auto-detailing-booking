import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** GET: list expenses, optionally filtered by month (YYYY-MM).
 *  Query: ?month=YYYY-MM (optional). No filter = current month.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const monthParam = url.searchParams.get("month");

    let monthStr;
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      monthStr = monthParam;
    } else {
      const now = new Date();
      monthStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    }

    const [yStr, mStr] = monthStr.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    const startDate = `${yStr}-${mStr}-01`;
    const nextMonth = m === 12 ? 1 : m + 1;
    const nextYear = m === 12 ? y + 1 : y;
    const endDate = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data, error } = await supabase
      .from("expenses")
      .select("id, expense_date, vendor, category, expense_type, description, amount, payment_method, receipt_saved, notes, created_at")
      .gte("expense_date", startDate)
      .lt("expense_date", endDate)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) {
      console.error("admin-list-expenses query failed", error);
      return res.status(500).json({ error: "Database query failed" });
    }

    return res.status(200).json({ ok: true, month: monthStr, expenses: data || [] });
  } catch (err) {
    console.error("admin-list-expenses error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
