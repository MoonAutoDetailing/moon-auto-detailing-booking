const STAGE_RANK = {
  lead: 1,
  quoted: 2,
  prospect: 2,
  contacted: 3,
  lost: 4,
  booked: 5,
  confirmed: 6,
  completed_customer: 7,
  repeat_customer: 8,
  do_not_contact: 99
};

const OPEN_TASK_STATUSES = ["open", "snoozed", "pending_response"];
const SALES_TASK_TYPES = [
  "lead_follow_up",
  "quote_follow_up",
  "check_response",
  "reactivation_follow_up",
  "winback_follow_up"
];
const LOST_TASK_TYPES = [
  "lead_follow_up",
  "quote_follow_up",
  "check_response"
];
const COMPLETED_BOOKING_STATUSES = ["completed", "complete", "done"];

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function stageRank(stage) {
  return STAGE_RANK[normalize(stage)] || 0;
}

export async function closeOpenTasksForCustomer(supabase, customerId, taskTypes, status = "dismissed") {
  if (!customerId || !taskTypes?.length) return [];
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("crm_follow_up_tasks")
    .update({
      status,
      completed_at: now,
      updated_at: now
    })
    .eq("customer_id", customerId)
    .in("task_type", taskTypes)
    .in("status", OPEN_TASK_STATUSES)
    .select("id, task_type, status");

  if (error) throw error;
  return data || [];
}

export async function cleanupTasksForLifecycle(supabase, customerId, profile = {}) {
  const stage = normalize(profile.lifecycle_stage);
  const status = normalize(profile.status);
  if (stage === "do_not_contact" || status === "do_not_contact") {
    return closeOpenTasksForCustomer(supabase, customerId, SALES_TASK_TYPES);
  }
  if (stage === "booked" || stage === "confirmed") {
    return closeOpenTasksForCustomer(supabase, customerId, SALES_TASK_TYPES);
  }
  if (stage === "lost" || stage === "ghosted" || status === "lost" || status === "ghosted") {
    return closeOpenTasksForCustomer(supabase, customerId, LOST_TASK_TYPES);
  }
  return [];
}

export async function createFollowUpTaskIfMissing(supabase, {
  customerId,
  bookingId = null,
  taskType,
  dueAt,
  priority = "medium",
  notes = null
}) {
  if (!customerId || !taskType || !dueAt) return null;

  let query = supabase
    .from("crm_follow_up_tasks")
    .select("id")
    .eq("customer_id", customerId)
    .eq("task_type", taskType)
    .in("status", OPEN_TASK_STATUSES)
    .limit(1);

  if (bookingId) {
    query = query.eq("booking_id", bookingId);
  }

  const { data: existing, error: existingError } = await query;
  if (existingError) throw existingError;
  if (existing?.length) return existing[0];

  const { data: task, error } = await supabase
    .from("crm_follow_up_tasks")
    .insert([{
      customer_id: customerId,
      booking_id: bookingId,
      task_type: taskType,
      due_at: dueAt,
      priority,
      status: "open",
      notes
    }])
    .select("*")
    .single();

  if (error) throw error;
  return task;
}

export async function ensureCancellationFollowUpTask(supabase, customerId, bookingId) {
  if (!customerId || !bookingId) return null;

  const { data: profile, error: profileError } = await supabase
    .from("crm_profiles")
    .select("do_not_contact, lifecycle_stage, status")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (profileError) throw profileError;

  const stage = normalize(profile?.lifecycle_stage);
  const status = normalize(profile?.status);
  if (profile?.do_not_contact === true || stage === "do_not_contact" || status === "do_not_contact") {
    return null;
  }

  return createFollowUpTaskIfMissing(supabase, {
    customerId,
    bookingId,
    taskType: "cancellation_follow_up",
    dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    priority: "high",
    notes: "Reach out to ask why the customer cancelled and see if they want to reschedule."
  });
}

export async function syncCrmProfileStage(supabase, customerId, updates = {}) {
  if (!customerId) return null;

  const { data: existingProfile, error: existingProfileError } = await supabase
    .from("crm_profiles")
    .select("*")
    .eq("customer_id", customerId)
    .maybeSingle();

  if (existingProfileError) throw existingProfileError;

  const existingStage = normalize(existingProfile?.lifecycle_stage || "lead");
  const targetStage = normalize(updates.lifecycle_stage);
  const targetDoNotContact = updates.do_not_contact === true || targetStage === "do_not_contact";

  if (existingStage === "do_not_contact" && !targetDoNotContact) {
    return existingProfile;
  }

  let nextStage = existingProfile?.lifecycle_stage ?? "lead";
  let stageApplied = false;
  if (targetStage) {
    if (targetDoNotContact || stageRank(targetStage) >= stageRank(existingStage)) {
      nextStage = targetStage;
      stageApplied = true;
    }
  }

  const profilePayload = {
    customer_id: customerId,
    company_name: existingProfile?.company_name ?? null,
    customer_type: existingProfile?.customer_type ?? "residential",
    lifecycle_stage: nextStage,
    lead_source: existingProfile?.lead_source ?? null,
    preferred_contact_method: existingProfile?.preferred_contact_method ?? "sms",
    status: (!targetStage || stageApplied) ? (clean(updates.status) || existingProfile?.status || "active") : (existingProfile?.status || "active"),
    priority: existingProfile?.priority ?? "medium",
    do_not_contact: targetDoNotContact ? true : (existingProfile?.do_not_contact ?? false),
    crm_notes: existingProfile?.crm_notes ?? null,
    updated_at: new Date().toISOString()
  };

  const { data: profile, error: profileError } = await supabase
    .from("crm_profiles")
    .upsert([profilePayload], { onConflict: "customer_id" })
    .select("*")
    .single();

  if (profileError) throw profileError;
  await cleanupTasksForLifecycle(supabase, customerId, profile);
  return profile;
}

export async function reconcileCustomerLifecycle(supabase, customerId) {
  if (!customerId) return null;

  const { data: existingProfile, error: profileError } = await supabase
    .from("crm_profiles")
    .select("*")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (profileError) throw profileError;

  const existingStage = normalize(existingProfile?.lifecycle_stage || "lead");
  const existingStatus = normalize(existingProfile?.status);
  if (
    existingProfile?.do_not_contact === true ||
    existingStage === "do_not_contact" ||
    existingStatus === "do_not_contact" ||
    existingStage === "lost" ||
    existingStage === "ghosted" ||
    existingStatus === "lost" ||
    existingStatus === "ghosted"
  ) {
    return existingProfile;
  }

  const { data: bookings, error: bookingsError } = await supabase
    .from("bookings")
    .select("id, status")
    .eq("customer_id", customerId);
  if (bookingsError) throw bookingsError;

  const statuses = (bookings || []).map((booking) => normalize(booking.status));
  const hasConfirmed = statuses.includes("confirmed");
  const hasPending = statuses.includes("pending");
  const completedCount = statuses.filter((status) => COMPLETED_BOOKING_STATUSES.includes(status)).length;

  let targetStage = null;
  if (hasConfirmed) {
    targetStage = "confirmed";
  } else if (hasPending) {
    targetStage = "booked";
  } else if (["booked", "confirmed"].includes(existingStage) || ["booked", "confirmed"].includes(existingStatus)) {
    if (completedCount >= 2) {
      targetStage = "repeat_customer";
    } else if (completedCount === 1) {
      targetStage = "completed_customer";
    } else {
      const { count, error: outreachError } = await supabase
        .from("crm_outreach_logs")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerId);
      if (outreachError) throw outreachError;
      targetStage = (count || 0) > 0 ? "contacted" : "lead";
    }
  }

  if (!targetStage || targetStage === existingStage) {
    return existingProfile;
  }

  const profilePayload = {
    customer_id: customerId,
    company_name: existingProfile?.company_name ?? null,
    customer_type: existingProfile?.customer_type ?? "residential",
    lifecycle_stage: targetStage,
    lead_source: existingProfile?.lead_source ?? null,
    preferred_contact_method: existingProfile?.preferred_contact_method ?? "sms",
    status: ["booked", "confirmed"].includes(existingStatus) ? "active" : (existingProfile?.status || "active"),
    priority: existingProfile?.priority ?? "medium",
    do_not_contact: existingProfile?.do_not_contact ?? false,
    crm_notes: existingProfile?.crm_notes ?? null,
    updated_at: new Date().toISOString()
  };

  const { data: profile, error: updateError } = await supabase
    .from("crm_profiles")
    .upsert([profilePayload], { onConflict: "customer_id" })
    .select("*")
    .single();
  if (updateError) throw updateError;

  await cleanupTasksForLifecycle(supabase, customerId, profile);
  return profile;
}
