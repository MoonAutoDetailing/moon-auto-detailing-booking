import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ ok: false, message: "Missing bookingId" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: booking, error } = await supabase
      .from("bookings")
      .select("*")
      .eq("id", bookingId)
      .single();

    if (error || !booking) {
      return res.status(404).json({ ok: false, message: "Booking not found" });
    }

    // Just confirm booking for now (no calendar, no SMS)
    await supabase
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", bookingId);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
