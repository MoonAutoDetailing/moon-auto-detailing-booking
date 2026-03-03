import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Use a real booking id from your database here:
  const testId = "PUT_A_REAL_BOOKING_ID_HERE";

  const { data, error } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", testId)
    .select();

  return res.status(200).json({ data, error });
}
