import verifyAdmin from "../_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { PHOTO_BUCKET } from "../_jobs.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** GET: list approved expenses, optionally filtered by month (YYYY-MM).
 *  Query: ?month=YYYY-MM (optional). No filter = current month.
 *  Crew submissions waiting for approval are listed by admin-expense-review instead.
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
      .select("id, expense_date, vendor, category, expense_type, description, amount, payment_method, receipt_saved, receipt_path, reimburse, reimbursed_at, submitted_by_staff_id, notes, created_at")
      .eq("status", "approved")
      .gte("expense_date", startDate)
      .lt("expense_date", endDate)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) {
      console.error("admin-list-expenses query failed", error);
      return res.status(500).json({ error: "Database query failed" });
    }

    // Short-lived receipt links and who submitted crew expenses.
    const rows = data || [];
    const paths = rows.map((r) => r.receipt_path).filter(Boolean);
    let urls = new Map();
    if (paths.length) {
      const { data: signed, error: sErr } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
      if (sErr) console.error("admin-list-expenses receipt links failed", sErr);
      urls = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
    }
    const staffIds = [...new Set(rows.map((r) => r.submitted_by_staff_id).filter(Boolean))];
    let names = new Map();
    if (staffIds.length) {
      const { data: staff } = await supabase.from("staff").select("id, full_name").in("id", staffIds);
      names = new Map((staff || []).map((s) => [s.id, s.full_name]));
    }
    const expenses = rows.map(({ receipt_path, submitted_by_staff_id, ...r }) => ({
      ...r,
      receipt_url: urls.get(receipt_path) || null,
      submitted_by: names.get(submitted_by_staff_id) || null,
    }));

    return res.status(200).json({ ok: true, month: monthStr, expenses });
  } catch (err) {
    console.error("admin-list-expenses error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
