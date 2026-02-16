import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { start, end } = req.body;
    if (!start || !end) {
      return res.status(400).json({ available: false });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    // Look for overlapping bookings
    const { data } = await supabase
      .from("bookings")
      .select("id")
      .not("status", "in", "(cancelled, denied)")
      .lt("scheduled_start", end)
      .gt("scheduled_end", start)
      .limit(1);

    const isAvailable = !data || data.length === 0;

    return res.status(200).json({ available: isAvailable });

  } catch (err) {
    console.error("availability check error:", err);
    return res.status(500).json({ available: false });
  }
}
