import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY.trim()
  );

  const { data, error } = await supabase
    .from("bookings")
    .select("id")
    .limit(1);

  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    hasKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    error,
    data
  });
}
