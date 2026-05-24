import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { sendCrmTemplateEmailCore } from "../lib/email/sendCrmTemplateEmailCore.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

// Single-recipient CRM sends only. Mass email requires unsubscribe support before implementation.
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-crm-send-email: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const body = req.body || {};
  const customerId = clean(body.customer_id);
  const bookingId = clean(body.booking_id);
  const templateKey = clean(body.template_key);
  const subject = clean(body.subject);
  const messageBody = clean(body.body);
  const now = new Date().toISOString();

  if (!customerId) {
    return res.status(400).json({ ok: false, error: "Missing customer_id" });
  }
  if (!subject) {
    return res.status(400).json({ ok: false, error: "Missing subject" });
  }
  if (!messageBody) {
    return res.status(400).json({ ok: false, error: "Missing body" });
  }

  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  );

  async function insertOutboundMessage(payload) {
    const { data, error } = await supabase
      .from("crm_outbound_messages")
      .insert([payload])
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  try {
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id, email")
      .eq("id", customerId)
      .maybeSingle();

    if (customerError) throw customerError;
    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
    }

    const recipientEmail = clean(customer.email);
    if (!recipientEmail) {
      return res.status(400).json({ ok: false, error: "Customer has no email on file" });
    }

    if (bookingId) {
      const { data: booking, error: bookingError } = await supabase
        .from("bookings")
        .select("id")
        .eq("id", bookingId)
        .maybeSingle();

      if (bookingError) throw bookingError;
      if (!booking) {
        return res.status(404).json({ ok: false, error: "Booking not found" });
      }
    }

    const { data: profile, error: profileError } = await supabase
      .from("crm_profiles")
      .select("do_not_contact, status")
      .eq("customer_id", customerId)
      .maybeSingle();

    if (profileError) throw profileError;

    if (profile?.do_not_contact === true || normalizeStatus(profile?.status) === "do_not_contact") {
      return res.status(403).json({ ok: false, error: "Customer is marked do not contact" });
    }

    let providerMessageId = null;
    try {
      const sendResult = await sendCrmTemplateEmailCore({
        to: recipientEmail,
        subject,
        body: messageBody,
        customerId
      });
      providerMessageId = sendResult.providerMessageId;
    } catch (sendErr) {
      const errorMessage = sendErr.message || "Email send failed";
      const failedMessage = await insertOutboundMessage({
        customer_id: customerId,
        booking_id: bookingId,
        channel: "email",
        provider: "resend",
        direction: "outbound",
        template_key: templateKey,
        subject,
        body: messageBody,
        recipient_email: recipientEmail,
        status: "failed",
        error_message: errorMessage,
        sent_by: "admin",
        sent_at: now
      });

      console.error("admin-crm-send-email send failed:", errorMessage);
      return res.status(500).json({
        ok: false,
        error: errorMessage,
        message: failedMessage
      });
    }

    const outboundMessage = await insertOutboundMessage({
      customer_id: customerId,
      booking_id: bookingId,
      channel: "email",
      provider: "resend",
      provider_message_id: providerMessageId,
      direction: "outbound",
      template_key: templateKey,
      subject,
      body: messageBody,
      recipient_email: recipientEmail,
      status: "sent",
      sent_by: "admin",
      sent_at: now
    });

    const { data: outreachLog, error: outreachError } = await supabase
      .from("crm_outreach_logs")
      .insert([{
        customer_id: customerId,
        booking_id: bookingId,
        contacted_at: now,
        method: "email",
        outreach_type: templateKey || "crm_email",
        message_summary: subject,
        response_status: "sent",
        response_notes: "Email sent through CRM template."
      }])
      .select("*")
      .single();

    if (outreachError) throw outreachError;

    return res.status(200).json({
      ok: true,
      message: outboundMessage,
      outreach_log: outreachLog
    });
  } catch (err) {
    console.error("admin-crm-send-email error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}
