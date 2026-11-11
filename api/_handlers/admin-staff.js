import verifyAdmin from "../_verifyAdmin.js";
import {
  serviceClient,
  hashSecret,
  validatePassword,
  validatePin,
  checkStaffChange,
  parseBody,
  STAFF_PUBLIC_COLUMNS,
} from "../_staffAuth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Team management (owner / manager).
 * GET   → { staff: [...] }
 * POST  { full_name, email, phone?, role, hourly_rate?, temp_password, pin? } → creates a login
 * PATCH { id, full_name?, email?, phone?, role?, hourly_rate?, active?, temp_password?, pin? }
 * A temp password forces the person to choose their own on next sign-in.
 */
export default async function handler(req, res) {
  let actor;
  try {
    ({ admin: actor } = await verifyAdmin(req));
  } catch (err) {
    return res.status(err?.status === 403 ? 403 : 401).json({ error: "Unauthorized" });
  }

  try {
    const sb = serviceClient();

    if (req.method === "GET") {
      const { data, error } = await sb
        .from("staff")
        .select(`${STAFF_PUBLIC_COLUMNS}, pin_hash`)
        .order("active", { ascending: false })
        .order("full_name");
      if (error) throw error;
      const staff = (data || []).map(({ pin_hash, ...s }) => ({ ...s, has_pin: !!pin_hash }));
      return res.status(200).json({ staff, me: actor });
    }

    const body = parseBody(req);

    if (req.method === "POST") {
      const full_name = String(body.full_name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const role = body.role || "employee";
      if (!full_name || !email.includes("@")) {
        return res.status(400).json({ error: "Name and a valid email are required" });
      }
      const changes = { role };
      if (body.hourly_rate !== undefined && body.hourly_rate !== "") changes.hourly_rate = body.hourly_rate;
      const denied = checkStaffChange(actor, null, changes);
      if (denied) return res.status(403).json({ error: denied });

      const pwProblem = validatePassword(body.temp_password);
      if (pwProblem) return res.status(400).json({ error: `Temporary password: ${pwProblem}` });
      if (body.pin) {
        const pinProblem = validatePin(String(body.pin));
        if (pinProblem) return res.status(400).json({ error: pinProblem });
      }

      const insert = {
        full_name,
        email,
        phone: body.phone ? String(body.phone).trim() : null,
        role,
        hourly_rate: changes.hourly_rate !== undefined ? Number(changes.hourly_rate) : null,
        password_hash: hashSecret(body.temp_password),
        pin_hash: body.pin ? hashSecret(String(body.pin)) : null,
        must_change_password: true,
        created_by: UUID_RE.test(actor.id) ? actor.id : null,
      };
      const { data, error } = await sb.from("staff").insert(insert).select(STAFF_PUBLIC_COLUMNS).single();
      if (error) {
        if (error.code === "23505") return res.status(409).json({ error: "That email already has an account" });
        throw error;
      }
      return res.status(201).json({ staff: data });
    }

    if (req.method === "PATCH") {
      if (!body.id) return res.status(400).json({ error: "Missing id" });
      const { data: target, error: tErr } = await sb
        .from("staff")
        .select("id, role, active")
        .eq("id", body.id)
        .maybeSingle();
      if (tErr) throw tErr;
      if (!target) return res.status(404).json({ error: "Not found" });

      const update = {};
      if (body.full_name !== undefined) update.full_name = String(body.full_name).trim();
      if (body.email !== undefined) update.email = String(body.email).trim().toLowerCase();
      if (body.phone !== undefined) update.phone = body.phone ? String(body.phone).trim() : null;
      if (body.role !== undefined) update.role = body.role;
      if (body.active !== undefined) update.active = !!body.active;
      if (body.hourly_rate !== undefined) {
        update.hourly_rate = body.hourly_rate === "" || body.hourly_rate === null ? null : Number(body.hourly_rate);
      }

      const denied = checkStaffChange(actor, target, update);
      if (denied) return res.status(403).json({ error: denied });

      if (body.temp_password) {
        const problem = validatePassword(body.temp_password);
        if (problem) return res.status(400).json({ error: `Temporary password: ${problem}` });
        update.password_hash = hashSecret(body.temp_password);
        update.must_change_password = true;
      }
      if (body.pin) {
        const problem = validatePin(String(body.pin));
        if (problem) return res.status(400).json({ error: problem });
        update.pin_hash = hashSecret(String(body.pin));
      }
      if (update.full_name === "") return res.status(400).json({ error: "Name cannot be empty" });
      if (update.email !== undefined && !update.email.includes("@")) {
        return res.status(400).json({ error: "Invalid email" });
      }
      if (update.hourly_rate !== undefined && update.hourly_rate !== null && !(update.hourly_rate >= 0)) {
        return res.status(400).json({ error: "Invalid hourly rate" });
      }

      update.updated_at = new Date().toISOString();
      const { data, error } = await sb
        .from("staff")
        .update(update)
        .eq("id", target.id)
        .select(STAFF_PUBLIC_COLUMNS)
        .single();
      if (error) {
        if (error.code === "23505") return res.status(409).json({ error: "That email already has an account" });
        throw error;
      }
      return res.status(200).json({ staff: data });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin-staff error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
