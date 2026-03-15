import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-staffing-clear: auth failed", err.message);
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

    const { error } = await supabase
      .from("staffing_overrides")
      .delete()
      .in("override_date", dates);

    if (error) throw error;
    return res.status(200).json({ cleared: dates.length, dates });
  } catch (err) {
    console.error("admin-staffing-clear", err);
    return res.status(500).json({ error: err.message || "Clear failed" });
  }
}
