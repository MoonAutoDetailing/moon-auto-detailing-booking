import { requireRole, ROLES, serviceClient, sendAuthError, parseBody } from "../_staffAuth.js";
import { createBookingCore } from "../_createBookingCore.js";
import { rememberCustomerAddress } from "../_customerAddresses.js";
import { sendBookingCreatedEmailCore } from "../../lib/email/sendBookingCreatedEmail.js";
import { reconcileCustomerLifecycle, syncCrmProfileStage } from "../_crmWorkflow.js";

// Only these fields are read from the crew app; prices, travel, manual times and status come
// from the server, never the browser.
const FIELDS = ["customer_id", "vehicle_id", "service_variant_id", "scheduled_start", "scheduled_end", "service_address", "customer_notes", "discount_code"];

/**
 * POST → books a customer from the crew app as a request: it lands in Bookings → To confirm
 * for a manager or the owner, at the standard price (plus a valid discount code), and only in
 * a time that's still open (same availability and travel check as the booking page). The
 * customer gets the "request received" email; the confirmation follows when it's confirmed.
 * bookings.booked_by records who booked it (shown on the admin card).
 */
export default async function handler(req, res) {
  const sb = serviceClient();
  let staff;
  try {
    staff = await requireRole(req, ROLES, { sb });
  } catch (err) {
    if (sendAuthError(res, err)) return;
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const raw = parseBody(req);
    const body = Object.fromEntries(FIELDS.filter((k) => raw[k] != null && raw[k] !== "").map((k) => [k, raw[k]]));

    const { data: vehicle, error: vErr } = await sb.from("vehicles").select("id, customer_id").eq("id", body.vehicle_id || "").maybeSingle();
    if (vErr) throw vErr;
    if (!vehicle || vehicle.customer_id !== body.customer_id) {
      return res.status(400).json({ error: "Pick a vehicle that belongs to this customer" });
    }

    const result = await createBookingCore({
      body,
      status: "pending",
      allowDiscount: true,
      allowSubscription: false,
      allowAvailabilityOverride: false,
    });
    if (!result.ok) return res.status(result.statusCode).json({ error: result.body?.message || result.body?.error || "Booking failed", ...result.body });

    const booking = result.booking;
    const { error: byErr } = await sb.from("bookings").update({ booked_by: staff.id }).eq("id", booking.id);
    if (byErr) console.error("staff-book: booked_by failed", byErr);
    try {
      await syncCrmProfileStage(sb, body.customer_id, { lifecycle_stage: "booked", status: "active" });
      await reconcileCustomerLifecycle(sb, body.customer_id);
      await rememberCustomerAddress(sb, body.customer_id, body.service_address);
    } catch (e) {
      console.error("staff-book: CRM/address follow-up failed", e);
    }
    try {
      await sendBookingCreatedEmailCore(booking.id);
    } catch (e) {
      console.error("[EMAIL] type=booking-created booking_id=" + booking.id + " status=failure", e);
    }

    console.log(`[STAFF_BOOKING] created status=pending booking_id=${booking.id} by=${staff.id}`);
    return res.status(200).json({ ok: true, bookingId: booking.id, status: "pending" });
  } catch (err) {
    console.error("staff-book error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
