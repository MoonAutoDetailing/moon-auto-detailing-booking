import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-staffing-enable: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const overrideDate = body.override_date ? body.override_date.toString().trim() : null;
    const overrideDates = Array.isArray(body.override_dates) ? body.override_dates.map((d) => String(d).trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : null;
    const dates = overrideDates && overrideDates.length > 0 ? overrideDates : (overrideDate && /^\d{4}-\d{2}-\d{2}$/.test(overrideDate) ? [overrideDate] : null);
    if (!dates || dates.length === 0) {
      return res.status(400).json({ error: "Provide override_date (YYYY-MM-DD) or override_dates array." });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    for (const d of dates) {
      await supabase
        .from("staffing_overrides")
        .upsert({ override_date: d, solo_mode: true, updated_at: new Date().toISOString() }, { onConflict: "override_date" });
    }
    return res.status(200).json({ enabled: dates.length, dates });
  } catch (err) {
    console.error("admin-staffing-enable", err);
    return res.status(500).json({ error: err.message || "Enable failed" });
  }
}
