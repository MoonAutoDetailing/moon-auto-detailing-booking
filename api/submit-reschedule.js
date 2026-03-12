import { createClient } from "@supabase/supabase-js";
import { sendRescheduleSubmittedEmailCore } from "../lib/email/sendRescheduleSubmittedEmail.js";
import { formatServiceName } from "../lib/email/_shared.js";


function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { bookingId, start, end } = req.body;

    if (!bookingId || !start || !end) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Update booking time and reset lifecycle
    const { error } = await supabase
      .from("bookings")
      .update({
        scheduled_start: start,
        scheduled_end: end,
        status: "pending",
        google_event_id: null,
        google_event_html_link: null
      })
      .eq("id", bookingId);

    if (error) {
      console.error("Reschedule update failed:", error);
      return res.status(500).json({ error: "Failed to update booking" });
    }
    
    // Fetch booking + snapshot pricing for notification
const { data: booking, error: bookingErr } = await supabase
  .from("bookings")
  .select(`
    manage_token,
    base_price,
    travel_fee,
    total_price,
    discount_code,
    discount_percent,
    discount_amount,
    customers(full_name,email),
    service_variants:service_variant_id(
  price,
  services(category,level)
)
  `)
  .eq("id", bookingId)
  .single();

if (bookingErr || !booking) {
  console.error("Failed to load booking after reschedule:", bookingErr);
  return res.status(500).json({ error: "Failed to load booking" });
}

// Send "reschedule submitted" email (must succeed or roll back)
const serviceLabel = formatServiceName(booking);

const emailResult = await sendRescheduleSubmittedEmailCore({
  email: booking.customers.email,
  fullName: booking.customers.full_name,
  newStart: start,
  newEnd: end,
  serviceLabel,
  price: booking.service_variants?.price ?? null,
  basePrice: booking.base_price ?? null,
  travelFee: booking.travel_fee ?? null,
  totalPrice: booking.total_price ?? null,
  discountCode: booking.discount_code ?? null,
  discountPercent: booking.discount_percent ?? null,
  discountAmount: booking.discount_amount ?? null,
  manageToken: booking.manage_token
});

if (!emailResult?.success) {
  console.error("Reschedule submitted email failed:", emailResult?.error);
  await supabase
    .from("bookings")
    .update({ status: "reschedule_requested" })
    .eq("id", bookingId);
  return res.status(500).json({ error: "Email failed; action rolled back" });
}

   return res.status(200).json({
  success: true,
  rescheduled: true,
  bookingId,
  manage_token: booking.manage_token
});

  } catch (err) {
    console.error("submit-reschedule error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
