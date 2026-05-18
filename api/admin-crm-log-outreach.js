import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

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
    console.error("admin-crm-log-outreach: auth failed", err.message);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const body = req.body || {};
    const customerId = clean(body.customer_id);
    const bookingId = clean(body.booking_id);
    const method = clean(body.method);
    const now = new Date().toISOString();

    if (!customerId) {
      return res.status(400).json({ ok: false, error: "Missing customer_id" });
    }
    if (!method) {
      return res.status(400).json({ ok: false, error: "Missing method" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customerId)
      .maybeSingle();

    if (customerError) throw customerError;
    if (!customer) {
      return res.status(404).json({ ok: false, error: "Customer not found" });
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

    const outreachType = clean(body.outreach_type);
    const messageSummary = clean(body.message_summary);
    const responseStatus = clean(body.response_status) || "no_response";
    const responseNotes = clean(body.response_notes);
    const nextFollowUpAt = clean(body.next_follow_up_at);

    const { data: outreachLog, error: outreachError } = await supabase
      .from("crm_outreach_logs")
      .insert([{
        customer_id: customerId,
        booking_id: bookingId,
        contacted_at: clean(body.contacted_at) || now,
        method,
        outreach_type: outreachType,
        message_summary: messageSummary,
        response_status: responseStatus,
        response_notes: responseNotes,
        next_follow_up_at: nextFollowUpAt
      }])
      .select("*")
      .single();

    if (outreachError) throw outreachError;

    let followUpTask = null;
    if (nextFollowUpAt) {
      const { data: task, error: taskError } = await supabase
        .from("crm_follow_up_tasks")
        .insert([{
          customer_id: customerId,
          booking_id: bookingId,
          task_type: outreachType || "general_follow_up",
          due_at: nextFollowUpAt,
          priority: clean(body.follow_up_priority) || "medium",
          status: "open",
          notes: clean(body.follow_up_notes) || responseNotes || messageSummary
        }])
        .select("*")
        .single();

      if (taskError) throw taskError;
      followUpTask = task;
    }

    if (responseStatus === "do_not_contact") {
      const { data: existingProfile, error: existingProfileError } = await supabase
        .from("crm_profiles")
        .select("*")
        .eq("customer_id", customerId)
        .maybeSingle();

      if (existingProfileError) throw existingProfileError;

      const { error: profileError } = await supabase
        .from("crm_profiles")
        .upsert([{
          customer_id: customerId,
          company_name: existingProfile?.company_name ?? null,
          customer_type: existingProfile?.customer_type ?? "residential",
          lifecycle_stage: "do_not_contact",
          lead_source: existingProfile?.lead_source ?? null,
          preferred_contact_method: existingProfile?.preferred_contact_method ?? "sms",
          status: "do_not_contact",
          priority: existingProfile?.priority ?? "medium",
          do_not_contact: true,
          crm_notes: existingProfile?.crm_notes ?? null,
          updated_at: now
        }], { onConflict: "customer_id" });

      if (profileError) throw profileError;
    }

    return res.status(200).json({
      ok: true,
      outreach_log: outreachLog,
      follow_up_task: followUpTask
    });
  } catch (err) {
    console.error("admin-crm-log-outreach error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}
