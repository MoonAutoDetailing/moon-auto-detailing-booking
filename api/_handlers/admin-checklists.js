import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient, parseBody } from "../_staffAuth.js";

const SCOPES = ["general", "interior", "exterior", "ceramic"];

/**
 * Job checklist steps (owner/manager).
 * GET → { steps } (active only)
 * POST { scope, min_level, step_order, text, required } → add a step
 * PATCH { id, text?, min_level?, step_order?, required? }
 * DELETE ?id → retires the step (kept for old jobs' history)
 */
export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const sb = serviceClient();
    const COLS = "id, scope, min_level, step_order, text, required";

    if (req.method === "GET") {
      const { data, error } = await sb.from("service_checklists").select(COLS).eq("active", true).order("step_order");
      if (error) throw error;
      return res.status(200).json({ steps: data || [] });
    }

    if (req.method === "DELETE") {
      if (!req.query?.id) return res.status(400).json({ error: "Missing id" });
      const { error } = await sb.from("service_checklists").update({ active: false }).eq("id", req.query.id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    const body = parseBody(req);
    const fields = {};
    if (body.text !== undefined) {
      fields.text = String(body.text).trim().slice(0, 300);
      if (!fields.text) return res.status(400).json({ error: "Step text is required" });
    }
    if (body.min_level !== undefined) {
      fields.min_level = Number(body.min_level) === 2 ? 2 : 1;
    }
    if (body.step_order !== undefined) {
      const n = parseInt(body.step_order, 10);
      if (!Number.isFinite(n)) return res.status(400).json({ error: "Invalid order" });
      fields.step_order = n;
    }
    if (body.required !== undefined) fields.required = !!body.required;

    if (req.method === "POST") {
      if (!SCOPES.includes(body.scope)) return res.status(400).json({ error: "Invalid scope" });
      if (!fields.text) return res.status(400).json({ error: "Step text is required" });
      const { data, error } = await sb
        .from("service_checklists")
        .insert({ scope: body.scope, min_level: 1, step_order: 50, required: true, ...fields })
        .select(COLS)
        .single();
      if (error) throw error;
      return res.status(201).json({ step: data });
    }

    if (req.method === "PATCH") {
      if (!body.id) return res.status(400).json({ error: "Missing id" });
      if (!Object.keys(fields).length) return res.status(400).json({ error: "Nothing to update" });
      const { data, error } = await sb.from("service_checklists").update(fields).eq("id", body.id).select(COLS).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "Step not found" });
      return res.status(200).json({ step: data });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin-checklists error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
