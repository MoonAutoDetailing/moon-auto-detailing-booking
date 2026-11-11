import crypto from "crypto";
import verifyAdmin from "../_verifyAdmin.js";
import { requireRole, ROLES, serviceClient, parseBody, AuthError } from "../_staffAuth.js";
import { PHOTO_BUCKET } from "../_jobs.js";
import { receiptPath, RECEIPT_TYPES } from "../_expenses.js";

/**
 * POST { content_type } → { path, upload_url } for a receipt photo/PDF.
 * The phone or admin page PUTs the file straight to Storage, then submits the path with
 * the expense. Any signed-in team member (crew header) or admin session may ask.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const sb = serviceClient();

  let owner = null;
  try {
    owner = (await requireRole(req, ROLES, { sb })).id;
  } catch (err) {
    if (!(err instanceof AuthError)) console.error("receipt-upload-url staff auth error:", err);
    try {
      await verifyAdmin(req);
      owner = "admin";
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const { content_type } = parseBody(req);
    if (!RECEIPT_TYPES.includes(content_type)) return res.status(400).json({ error: "Receipts must be a photo or PDF" });
    const path = receiptPath(owner, crypto.randomUUID(), content_type);
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUploadUrl(path);
    if (error) throw error;
    return res.status(200).json({ path, upload_url: data.signedUrl });
  } catch (err) {
    console.error("receipt-upload-url error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
