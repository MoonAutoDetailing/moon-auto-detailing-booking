import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }

  // Generate unique email so the endpoint can be run repeatedly
  const uuid = crypto.randomUUID();
  const testEmail = `test-${uuid}@example.com`;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const bookingId = crypto.randomUUID();
  const manageToken = crypto.randomUUID();
  const customerId = crypto.randomUUID();
  const vehicleId = crypto.randomUUID();

  const now = new Date();
  const scheduledStart = new Date(now.getTime() + 24 * 60 * 60 * 1000);
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

  const { error } = await supabase.from("bookings").insert({
    id: bookingId,
    customer_id: customerId,
    vehicle_id: vehicleId,
    service_variant_id: serviceVariantId,
    status: "pending",
    scheduled_start: scheduledStart.toISOString(),
    scheduled_end: scheduledEnd.toISOString(),
    service_address: "TEST ADDRESS",
    manage_token: manageToken,
  });

  if (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }

  return res.status(200).json({
    ok: true,
    bookingId,
    manageToken,
  });
}
