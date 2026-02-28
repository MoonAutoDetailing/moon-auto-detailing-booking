import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { sendRescheduleLinkEmailCore } from "../lib/email/sendRescheduleLinkEmail.js";


function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  let body = req.body;
  if (!body) {
    try {
      body = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => (data += chunk));
        req.on("end", () => resolve(JSON.parse(data || "{}")));
        req.on("error", reject);
      });
    } catch (err) {
      console.error("Failed to parse JSON body", err);
      return res.status(400).json({ message: "Invalid JSON body" });
    }
  }

  const token = body.token || body.manage_token;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!token) return res.status(400).json({ message: "Missing token" });

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    // =========================
    // 1) Fetch booking
    // =========================
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("id, google_event_id, status, customer_id, service_variant_id, manage_token, reschedule_token")
      .eq("manage_token", token)
      .single();

    if (error || !booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

   if (booking.status === "reschedule_requested") {
  // Re-send reschedule link email (don’t dead-end the customer)
  try {
    const { data: customer, error: customerErr } = await supabase
      .from("customers")
      .select("full_name, email")
      .eq("id", booking.customer_id)
      .single();

    if (customerErr || !customer?.email) {
      console.error("RESCHEDULE FLOW — missing customer email", { bookingId: booking.id, customerId: booking.customer_id, customerErr });
      return res.status(500).json({ message: "Email failed; action rolled back" });
    }

    const { data: variantRow, error: variantErr } = await supabase
      .from("service_variants")
      .select("price, service:services(category,level)")
      .eq("id", booking.service_variant_id)
      .single();

    const serviceLabel = variantRow?.service
      ? `${variantRow.service.category} Detail ${variantRow.service.level}`
      : "Service";

    const price = variantRow?.price ?? null;

    console.log("RESCHEDULE FLOW — about to send reschedule email", {
      bookingId: booking.id,
      customerEmail: customer.email
    });
    const emailResult = await sendRescheduleLinkEmailCore({
      email: customer.email,
      fullName: customer.full_name,
      manageToken: booking.manage_token,
      rescheduleToken: booking.reschedule_token,
      serviceLabel,
      price
    });
    console.log("RESCHEDULE FLOW — email function returned", emailResult);

    if (!emailResult?.success) {
      return res.status(500).json({ message: "Email failed; action rolled back" });
    }
  } catch (err) {
    console.error("Reschedule re-send failed:", err);
    return res.status(500).json({ message: "Email failed; action rolled back" });
  }

  return res.status(200).json({
    message: "Reschedule link sent. Please check your email to pick a new time."
  });
}

    // =========================
    // 2) Remove calendar event
    // =========================
    if (booking.google_event_id) {
      const decoded = Buffer.from(
        requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON"),
        "base64"
      ).toString("utf-8");

      const creds = JSON.parse(decoded);

      const auth = new google.auth.JWT({
        email: creds.client_email,
        key: creds.private_key.replace(/\\n/g, "\n"),
        scopes: ["https://www.googleapis.com/auth/calendar"]
      });

      const calendar = google.calendar({ version: "v3", auth });

      try {
        await calendar.events.delete({
          calendarId: requireEnv("GOOGLE_CALENDAR_ID").trim(),
          eventId: booking.google_event_id
        });
      } catch (err) {
        console.error("Calendar delete warning:", err.message);
      }
    }

    // =========================
    // 3) Update booking status
    // =========================
    await supabase
  .from("bookings")
  .update({
    status: "reschedule_requested",
    google_event_id: null,
    google_event_html_link: null
  })
  .eq("id", booking.id);

    // 4) Send reschedule email (must succeed or roll back)
try {
  const { data: customer, error: customerErr } = await supabase
    .from("customers")
    .select("full_name, email")
    .eq("id", booking.customer_id)
    .single();

  if (customerErr || !customer?.email) {
    console.error("RESCHEDULE FLOW — missing customer email", { bookingId: booking.id, customerId: booking.customer_id, customerErr });
    await supabase
      .from("bookings")
      .update({ status: booking.status })
      .eq("id", booking.id);
    return res.status(500).json({ message: "Email failed; action rolled back" });
  }

  const { data: variantRow, error: variantErr } = await supabase
    .from("service_variants")
    .select("price, service:services(category,level)")
    .eq("id", booking.service_variant_id)
    .single();

  const serviceLabel = variantRow?.service
    ? `${variantRow.service.category} Detail ${variantRow.service.level}`
    : "Service";

  const price = variantRow?.price ?? null;

  console.log("RESCHEDULE FLOW — about to send reschedule email", {
    bookingId: booking.id,
    customerEmail: customer.email
  });
  const emailResult = await sendRescheduleLinkEmailCore({
    email: customer.email,
    fullName: customer.full_name,
    manageToken: booking.manage_token,
    rescheduleToken: booking.reschedule_token,
    serviceLabel,
    price
  });
  console.log("RESCHEDULE FLOW — email function returned", emailResult);

  if (!emailResult?.success) {
    console.error("Reschedule email failed:", emailResult?.error);
    await supabase
      .from("bookings")
      .update({ status: booking.status })
      .eq("id", booking.id);
    return res.status(500).json({ message: "Email failed; action rolled back" });
  }
} catch (err) {
  console.error("Reschedule email failed:", err);
  await supabase
    .from("bookings")
    .update({ status: booking.status })
    .eq("id", booking.id);
  return res.status(500).json({ message: "Email failed; action rolled back" });
}

    return res.status(200).json({
  message: "Reschedule started. Please check your email to pick a new time."
});


  } catch (err) {
    console.error("customer-reschedule-booking error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}
