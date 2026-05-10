import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function escapeIlike(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(200).json({ ok: true, customers: [] });

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const safe = escapeIlike(q);
    const { data, error } = await supabase
      .from("customers")
      .select("id, full_name, email, phone")
      .or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%`)
      .order("full_name", { ascending: true })
      .limit(20);

    if (error) throw error;

    return res.status(200).json({
      ok: true,
      customers: (data || []).map((c) => ({
        id: c.id,
        full_name: c.full_name,
        email: c.email,
        phone: c.phone
      }))
    });
  } catch (err) {
    console.error("admin-search-customers error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
