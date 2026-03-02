import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  console.log("admin-bookings: handler start");
  try {
    // 1) Verify admin session
   try {
  await verifyAdmin(req);
} catch (err) {
  console.error("admin-bookings: auth failed", err.message);
  return res.status(401).json({ error: "Unauthorized" });
}

    if (!process.env.SUPABASE_URL) {
  console.error("Missing SUPABASE_URL");
  return res.status(500).json({ error: "Missing SUPABASE_URL" });
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });
}

    // 2) Create Supabase SERVER client (service role key)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 3) Fetch confirmed bookings with joined relations (read-only, safe to join)
    const { data, error } = await supabase
      .from("bookings")
      .select(`
    id,
    scheduled_start,
    scheduled_end,
    status,
    service_address,
    customers (
      full_name,
      email
    ),
    service_variants (
      price,
      services (
        category,
        level
      )
    )
  `)
      .eq("status", "confirmed")
      .order("scheduled_start", { ascending: true });

    if (error) {
  console.error("admin-bookings: supabase error", error);
  return res.status(500).json({ error: "Database query failed" });
}

   return res.status(200).json({ bookings: data });

  } catch (err) {
    console.error("ADMIN BOOKINGS ERROR:", err.message);
    res.status(500).json({ error: "Server error" });
  }
}
