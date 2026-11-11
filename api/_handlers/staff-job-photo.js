import crypto from "crypto";
import { requireRole, ROLES, serviceClient, sendAuthError, parseBody } from "../_staffAuth.js";
import { PHOTO_BUCKET, PHOTO_KINDS, photoPath, isPathForJob, withSignedUrls } from "../_jobs.js";

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };

/**
 * Photos upload straight from the phone to Storage (no size limit on our function):
 * POST { action: "sign", booking_id, kind, content_type } → { path, upload_url }
 * PUT the file to upload_url, then
 * POST { action: "confirm", booking_id, kind, path, caption? } → { photo }
 * DELETE ?id → removes your own photo while the job is still open.
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

  const openJob = async (bookingId) => {
    const { data, error } = await sb.from("bookings").select("id, status").eq("id", bookingId).maybeSingle();
    if (error) throw error;
    return data && data.status === "confirmed" ? data : null;
  };

  try {
    if (req.method === "DELETE") {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: "Missing id" });
      const { data: photo, error } = await sb.from("job_photos").select("id, booking_id, staff_id, storage_path").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!photo) return res.status(404).json({ error: "Photo not found" });
      const isManager = staff.role !== "employee";
      if (photo.staff_id !== staff.id && !isManager) return res.status(403).json({ error: "You can only remove your own photos" });
      if (!(await openJob(photo.booking_id))) return res.status(409).json({ error: "Photos on a completed job can't be removed" });
      await sb.storage.from(PHOTO_BUCKET).remove([photo.storage_path]);
      const { error: delErr } = await sb.from("job_photos").delete().eq("id", id);
      if (delErr) throw delErr;
      return res.status(200).json({ ok: true });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req);
    const bookingId = body.booking_id;
    const kind = body.kind;
    if (!bookingId || !PHOTO_KINDS.includes(kind)) return res.status(400).json({ error: "Missing booking_id or invalid kind" });
    if (!(await openJob(bookingId))) return res.status(409).json({ error: "This job isn't open for photos" });

    if (body.action === "sign") {
      const ext = EXT[body.content_type] || "jpg";
      const path = photoPath(bookingId, kind, crypto.randomUUID(), ext);
      const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUploadUrl(path);
      if (error) throw error;
      return res.status(200).json({ path, upload_url: data.signedUrl });
    }

    if (body.action === "confirm") {
      if (!isPathForJob(body.path, bookingId, kind)) return res.status(400).json({ error: "Invalid path" });
      const { data, error } = await sb
        .from("job_photos")
        .insert({
          booking_id: bookingId,
          staff_id: staff.id,
          kind,
          storage_path: body.path,
          caption: body.caption ? String(body.caption).slice(0, 300) : null,
        })
        .select("id, kind, storage_path, staff_id, caption, taken_at")
        .single();
      if (error) {
        if (error.code === "23505") return res.status(409).json({ error: "Photo already saved" });
        throw error;
      }
      const [signed] = await withSignedUrls(sb, [data]);
      const { storage_path, ...photo } = signed;
      return res.status(201).json({ photo: { ...photo, mine: true } });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("staff-job-photo error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
