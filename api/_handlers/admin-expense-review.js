import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient, parseBody } from "../_staffAuth.js";
import { PHOTO_BUCKET } from "../_jobs.js";
import { parseReview } from "../_expenses.js";

const COLS =
  "id, expense_date, vendor, category, expense_type, description, amount, payment_method, reimburse, receipt_path, status, submitted_by_staff_id, created_at";

/**
 * Crew expense approvals (owner / manager).
 * GET → { pending: [...] } every expense waiting for approval, with receipt links
 * PATCH { id, status: "approved"|"rejected", category?, expense_type?, payment_method?, amount?, note? }
 */
export default async function handler(req, res) {
  let actor;
  try {
    ({ admin: actor } = await verifyAdmin(req));
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const sb = serviceClient();

    if (req.method === "GET") {
      const [{ data, error }, { data: staff, error: sErr }] = await Promise.all([
        sb.from("expenses").select(COLS).eq("status", "pending").order("created_at"),
        sb.from("staff").select("id, full_name"),
      ]);
      if (error) throw error;
      if (sErr) throw sErr;
      const names = new Map((staff || []).map((s) => [s.id, s.full_name]));
      const rows = data || [];
      const paths = rows.map((r) => r.receipt_path).filter(Boolean);
      let urls = new Map();
      if (paths.length) {
        const { data: signed, error: uErr } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
        if (uErr) throw uErr;
        urls = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
      }
      return res.status(200).json({
        pending: rows.map(({ receipt_path, ...r }) => ({
          ...r,
          receipt_url: urls.get(receipt_path) || null,
          receipt_is_pdf: /\.pdf$/.test(receipt_path || ""),
          submitted_by: names.get(r.submitted_by_staff_id) || "Unknown",
        })),
      });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      if (!body.id) return res.status(400).json({ error: "Missing id" });
      const { error, update } = parseReview(body, actor.name ? `${actor.name} (${actor.id})` : actor.id);
      if (error) return res.status(400).json({ error });
      const { data, error: upErr } = await sb
        .from("expenses")
        .update(update)
        .eq("id", body.id)
        .eq("status", "pending")
        .select("id, status")
        .maybeSingle();
      if (upErr) throw upErr;
      if (!data) return res.status(409).json({ error: "Already reviewed" });
      return res.status(200).json({ expense: data });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin-expense-review error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
