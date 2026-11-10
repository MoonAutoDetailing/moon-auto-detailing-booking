import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }

  // Generate unique email so the endpoint can be run repeatedly
  const uuid = crypto.randomUUID();
  const testEmail = `darrenwmoon1010+test-${crypto.randomUUID()}@gmail.com`;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const bookingId = crypto.randomUUID();
  const manageToken = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const vehicleId = crypto.randomUUID();

  const now = new Date();
  // Deterministic start time to avoid overlap collisions in repeated tests.
  // Tomorrow at 8:00 AM local server time, plus a rolling offset (0–599 minutes).
  const base = new Date(now);
  base.setDate(base.getDate() + 1);
  base.setHours(8, 0, 0, 0);

  const rollingMinutes = now.getMinutes() + now.getHours() * 60;
  const minuteOffset = rollingMinutes % 600; // 0..599 minutes (10-hour span)

  const scheduledStart = new Date(base.getTime() + minuteOffset * 60 * 1000);
  const scheduledEnd = new Date(scheduledStart.getTime() + 2 * 60 * 60 * 1000);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { error: custErr } = await supabase.from("customers").insert({
    id: customerId,
    full_name: "Test Customer",
    email: testEmail,
    address: "123 Test Street",
  });
  if (custErr) {
    return res.status(500).json({ ok: false, message: "Customer insert: " + custErr.message });
  }

  const { error: vehErr } = await supabase.from("vehicles").insert({
    id: vehicleId,
    customer_id: customerId,
    vehicle_year: 2018,
    vehicle_make: "Toyota",
    vehicle_model: "Camry",
    vehicle_size: "midsized",
  });
  if (vehErr) {
    return res.status(500).json({ ok: false, message: "Vehicle insert: " + vehErr.message });
  }

  const { data: variants, error: varErr } = await supabase
    .from("service_variants")
    .select("id")
    .limit(1);
  if (varErr || !variants?.length) {
    return res.status(500).json({ ok: false, message: "No service_variant found: " + (varErr?.message || "empty") });
  }
  const serviceVariantId = variants[0].id;

  const durationMs = 2 * 60 * 60 * 1000; // 2 hours
  // search up to 7 days ahead in 30-minute increments
  const stepMs = 30 * 60 * 1000;
  const maxAttempts = 48 * 7; // 336 attempts (~7 days)

  let insertErr = null;
  let bookingRow = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const scheduled_start = new Date(scheduledStart.getTime() + attempt * stepMs);
    const scheduled_end = new Date(scheduled_start.getTime() + durationMs);

    const { data: bookingData, error: bookingError } = await supabase
      .from("bookings")
      .insert([{
        customer_id: customerId,
        vehicle_id: vehicleId,
        service_variant_id: serviceVariantId,
        status: "pending",
        scheduled_start: scheduled_start.toISOString(),
        scheduled_end: scheduled_end.toISOString(),
        service_address: "TEST ADDRESS",
        manage_token: manageToken,
      }])
      .select("id, manage_token")
      .single();

    if (!bookingError) {
      bookingRow = bookingData;
      insertErr = null;
      break;
    }

    insertErr = bookingError;

    const msg = (bookingError.message || "").toLowerCase();
    if (!msg.includes("bookings_no_overlap") && !msg.includes("exclusion constraint")) {
      break;
    }
  }

  if (!bookingRow) {
    console.error("dev-create-test-booking: failed to insert after retries", insertErr);
    return res.status(500).json({ ok: false, message: insertErr?.message || "Booking insert failed" });
  }

  return res.status(200).json({
    ok: true,
    bookingId: bookingRow.id,
    manageToken,
    customer_id: customerId,
    vehicle_id: vehicleId,
    service_variant_id: serviceVariantId
  });
}
