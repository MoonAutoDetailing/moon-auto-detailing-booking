import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function firstDayOfMonth(y, m) {
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function lastDayOfMonth(y, m) {
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-staffing-list: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const year = parseInt(url.searchParams.get("year"), 10);
    const month = parseInt(url.searchParams.get("month"), 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: "Invalid year or month" });
    }

    const startDate = firstDayOfMonth(year, month);
    const endDate = lastDayOfMonth(year, month);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: rows } = await supabase
      .from("staffing_overrides")
      .select("override_date")
      .eq("solo_mode", true)
      .gte("override_date", startDate)
      .lte("override_date", endDate);

    const soloDates = (rows || []).map((r) => r.override_date).filter(Boolean);
    return res.status(200).json({ soloDates });
  } catch (err) {
    console.error("admin-staffing-list", err);
    return res.status(500).json({ error: err.message || "List failed" });
  }
}
