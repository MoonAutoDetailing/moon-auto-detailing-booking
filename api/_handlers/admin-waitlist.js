import verifyAdmin from "../_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** GET: list waitlist entries (newest first). PATCH: { id, contacted } toggles contacted. */
export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("waitlist")
        .select("id, full_name, email, phone, interest, preferred_plan, vehicle, notes, source, contacted, contacted_at, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return res.status(200).json({ entries: data || [] });
    }

    if (req.method === "PATCH") {
      const { id, contacted } = req.body || {};
      if (!id || typeof contacted !== "boolean") {
        return res.status(400).json({ error: "Missing id or contacted" });
      }
      const { data, error } = await supabase
        .from("waitlist")
        .update({ contacted, contacted_at: contacted ? new Date().toISOString() : null })
        .eq("id", id)
        .select("id, contacted, contacted_at")
        .single();
      if (error) throw error;
      return res.status(200).json({ entry: data });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("admin-waitlist error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
