import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Use a real booking id from your database here:
  const testId = "e26cb11e-d7c9-4d08-b314-d94499ed6905";

  const { data, error } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", testId)
    .select();

  return res.status(200).json({ data, error });
}
