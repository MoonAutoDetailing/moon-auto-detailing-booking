import { requireRole, ROLES, serviceClient, sendAuthError, parseBody } from "../_staffAuth.js";
import { todayNY } from "../_subscriptions/lifecycle.js";
import { PHOTO_BUCKET } from "../_jobs.js";
import { parseCrewExpense, CREW_CATEGORIES, CREW_PAID_WITH } from "../_expenses.js";

const COLS = "id, expense_date, vendor, category, description, amount, payment_method, reimburse, reimbursed_at, status, review_note, receipt_path, created_at";

/**
 * The signed-in crew member's own expenses.
 * GET → { expenses (last 90 days, with receipt links), categories, paid_with }
 * POST { receipt_path, amount, vendor, category, paid_with, expense_date?, description? }
 *      → submits for manager approval (receipt required)
 * DELETE ?id → withdraws one of your own pending expenses
 */
export default async function handler(req, res) {
  const sb = serviceClient();
  let staff;
  try {
    staff = await requireRole(req, ROLES, { sb });
  } catch (err) {
    if (sendAuthError(res, err)) return;
    return res.status(401).json({ error: "Unauthorized" });
  }

  const list = async () => {
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const { data, error } = await sb
      .from("expenses")
      .select(COLS)
      .eq("submitted_by_staff_id", staff.id)
      .gte("expense_date", since)
      .order("created_at", { ascending: false });
    if (error) throw error;
    const rows = data || [];
    const paths = rows.map((r) => r.receipt_path).filter(Boolean);
    let urls = new Map();
    if (paths.length) {
      const { data: signed, error: sErr } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
      if (sErr) throw sErr;
      urls = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
    }
    return {
      today: todayNY(),
      categories: CREW_CATEGORIES,
      paid_with: Object.entries(CREW_PAID_WITH).map(([key, v]) => ({ key, label: v.label })),
      expenses: rows.map(({ receipt_path, ...r }) => ({ ...r, receipt_url: urls.get(receipt_path) || null })),
    };
  };

  try {
    if (req.method === "GET") return res.status(200).json(await list());

    if (req.method === "POST") {
      const { error, expense } = parseCrewExpense(parseBody(req), { today: todayNY(), staffId: staff.id });
      if (error) return res.status(400).json({ error });
      // Receipts uploaded by someone else can't be attached to your expense.
      if (!expense.receipt_path.startsWith(`receipts/${staff.id}/`)) return res.status(400).json({ error: "Upload the receipt again" });
      const { error: insErr } = await sb.from("expenses").insert(expense);
      if (insErr) throw insErr;
      return res.status(201).json(await list());
    }

    if (req.method === "DELETE") {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: "Missing id" });
      const { data: row, error } = await sb
        .from("expenses")
        .select("id, receipt_path, status, submitted_by_staff_id")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!row || row.submitted_by_staff_id !== staff.id) return res.status(404).json({ error: "Expense not found" });
      if (row.status !== "pending") return res.status(409).json({ error: "Only expenses waiting for approval can be withdrawn" });
      const { error: delErr } = await sb.from("expenses").delete().eq("id", id).eq("status", "pending");
      if (delErr) throw delErr;
      if (row.receipt_path) await sb.storage.from(PHOTO_BUCKET).remove([row.receipt_path]);
      return res.status(200).json(await list());
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("staff-expenses error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
