import verifyAdmin from "../_verifyAdmin.js";
import { serviceClient, parseBody } from "../_staffAuth.js";

/**
 * POST { bookingId } → marks the booking reschedule_requested.
 * Replaces the admin page's direct anon-key update (removed with the RLS lockdown).
 * The page still deletes the calendar event and sends the reschedule email itself.
 */
export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { bookingId } = parseBody(req);
    if (!bookingId) return res.status(400).json({ error: "Missing bookingId" });

    const { data, error } = await serviceClient()
      .from("bookings")
      .update({ status: "reschedule_requested" })
      .eq("id", bookingId)
      .in("status", ["pending", "confirmed"])
      .select("id, status")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: "Booking is not pending or confirmed" });
    return res.status(200).json({ ok: true, booking: data });
  } catch (err) {
    console.error("admin-request-reschedule error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
