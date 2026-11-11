import { requireRole, ROLES, serviceClient, sendAuthError, parseBody } from "../_staffAuth.js";
import {
  JOB_SELECT,
  crewJobView,
  loadChecklistSteps,
  stepsForBooking,
  completionProblems,
  countPhotos,
  withSignedUrls,
  minPhotos,
} from "../_jobs.js";

/**
 * GET ?id → one job with its checklist, saved progress, photos (signed URLs), crew list and
 *           what still blocks completion.
 * POST { id, action: "start" } → marks the job started (once).
 * POST { id, action: "checklist", checklist: { [stepId]: true } } → saves progress.
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

  try {
    const body = req.method === "POST" ? parseBody(req) : {};
    const id = req.query?.id || body.id;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const { data: booking, error } = await sb.from("bookings").select(JOB_SELECT).eq("id", id).maybeSingle();
    if (error) throw error;
    if (!booking || !["confirmed", "completed"].includes(booking.status)) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (req.method === "POST") {
      if (booking.status === "completed") return res.status(409).json({ error: "Job is already completed" });
      const now = new Date().toISOString();
      const { data: existing, error: exErr } = await sb
        .from("job_completions")
        .select("booking_id, started_at, checklist")
        .eq("booking_id", id)
        .maybeSingle();
      if (exErr) throw exErr;

      if (body.action === "start") {
        if (!existing) {
          const { error: insErr } = await sb
            .from("job_completions")
            .insert({ booking_id: id, started_at: now, started_by: staff.id });
          if (insErr && insErr.code !== "23505") throw insErr;
        } else if (!existing.started_at) {
          await sb.from("job_completions").update({ started_at: now, started_by: staff.id, updated_at: now }).eq("booking_id", id);
        }
      } else if (body.action === "checklist") {
        const checklist = {};
        for (const [k, v] of Object.entries(body.checklist || {})) if (v === true) checklist[k] = true;
        if (existing) {
          const { error: upErr } = await sb.from("job_completions").update({ checklist, updated_at: now }).eq("booking_id", id);
          if (upErr) throw upErr;
        } else {
          const { error: insErr } = await sb
            .from("job_completions")
            .insert({ booking_id: id, started_at: now, started_by: staff.id, checklist });
          if (insErr) throw insErr;
        }
      } else {
        return res.status(400).json({ error: "Unknown action" });
      }
    } else if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const [steps, { data: work, error: wErr }, { data: photos, error: pErr }, { data: crew, error: cErr }, { data: worked, error: bsErr }] =
      await Promise.all([
        loadChecklistSteps(sb),
        sb.from("job_completions").select("*").eq("booking_id", id).maybeSingle(),
        sb.from("job_photos").select("id, kind, storage_path, staff_id, caption, taken_at").eq("booking_id", id).order("taken_at"),
        sb.from("staff").select("id, full_name, role").eq("active", true).order("full_name"),
        sb.from("booking_staff").select("staff_id").eq("booking_id", id),
      ]);
    if (wErr) throw wErr;
    if (pErr) throw pErr;
    if (cErr) throw cErr;
    if (bsErr) throw bsErr;

    const svc = booking.service_variants?.services || {};
    const jobSteps = stepsForBooking(steps, { category: svc.category, level: svc.level, jobFlag: booking.job_flag })
      .map(({ id: stepId, scope, text, required }) => ({ id: stepId, scope, text, required }));
    const checked = work?.checklist || {};
    const photoCounts = countPhotos(photos);
    const signed = await withSignedUrls(sb, photos || []);

    return res.status(200).json({
      job: crewJobView(booking, { photo_counts: photoCounts }),
      checklist: jobSteps,
      checked,
      work: work
        ? { started_at: work.started_at, completed_at: work.completed_at, completed_by: work.completed_by }
        : null,
      photos: signed.map(({ storage_path, ...p }) => ({ ...p, mine: p.staff_id === staff.id })),
      min_photos: minPhotos(),
      problems: booking.status === "completed" ? [] : completionProblems({ steps: jobSteps, checked, photoCounts }),
      crew: (crew || []).map((c) => ({ id: c.id, full_name: c.full_name, role: c.role })),
      worked_by: (worked || []).map((w) => w.staff_id),
      me: staff.id,
    });
  } catch (err) {
    console.error("staff-job error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
