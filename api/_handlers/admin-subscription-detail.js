import verifyAdmin from "../_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd, todayNY } from "../_subscriptions/lifecycle.js";
import { buildNextService, planLabel } from "../_subscriptions/memberContext.js";
import { resolveSubscriptionById } from "../_subscriptions/resolveSubscriptionById.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Customer-visible total for a subscription cycle booking.
 * create-booking.js stores bookings.total_price = base_price + travel_fee only;
 * pushback fee is stored on subscription_cycle_bookings and is NOT in total_price.
 * So we must add pushback_fee_amount when pushback_fee_applied to avoid undercounting.
 */
function customerVisibleTotalForCycleBooking(bookingTotalPrice, scb) {
  const total = toNum(bookingTotalPrice);
  const pushbackFee = scb && scb.pushback_fee_applied === true ? toNum(scb.pushback_fee_amount) : 0;
  return total + pushbackFee;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await verifyAdmin(req);
  } catch (err) {
    console.error("admin-subscription-detail: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const subscriptionId = req.query.id || req.query.subscription_id;
  if (!subscriptionId) {
    return res.status(400).json({ error: "Missing id or subscription_id" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const resolved = await resolveSubscriptionById(supabase, subscriptionId);
    if (resolved.error) {
      return res.status(resolved.status || 500).json({ error: resolved.error });
    }

    const { subscription, activeCycle } = resolved;
    const today = todayNY();

    const { data: allCycles } = await supabase
      .from("subscription_cycles")
      .select("*")
      .eq("subscription_id", subscription.id)
      .order("cycle_index", { ascending: false });
    const cycles = allCycles || [];
    const cycleIds = cycles.map((c) => c.id);

    let links = [];
    if (cycleIds.length > 0) {
      const { data } = await supabase
        .from("subscription_cycle_bookings")
        .select("id, cycle_id, booking_id, price_mode, pushback_fee_applied, pushback_fee_amount, admin_override, released_at, created_at, bookings:booking_id(id, status, scheduled_start, total_price, base_price, travel_fee, manage_token)")
        .in("cycle_id", cycleIds);
      links = data || [];
    }
    const activeLinkByCycle = {};
    links.filter((l) => !l.released_at).forEach((l) => { activeLinkByCycle[l.cycle_id] = l; });

    // Lifetime value: what was actually collected for this plan's completed services.
    const completedBookingIds = links
      .filter((l) => !l.released_at && l.bookings?.status === "completed")
      .map((l) => l.booking_id);
    let lifetimeValue = 0;
    if (completedBookingIds.length) {
      const { data: payments } = await supabase
        .from("job_payments")
        .select("booking_id, amount_collected")
        .in("booking_id", completedBookingIds);
      lifetimeValue = (payments || []).reduce((t, p) => t + toNum(p.amount_collected), 0);
    }

    // The member's bookings that aren't attached to any cycle (candidates for "attach booking").
    const linkedIds = new Set(links.filter((l) => !l.released_at).map((l) => l.booking_id));
    const { data: customerBookings } = await supabase
      .from("bookings")
      .select("id, status, scheduled_start, total_price, vehicle_id, vehicles:vehicle_id(vehicle_make, vehicle_model)")
      .eq("customer_id", subscription.customer_id)
      .in("status", ["pending", "confirmed", "reschedule_requested", "completed"])
      .order("scheduled_start", { ascending: false })
      .limit(40);
    const unlinkedBookings = (customerBookings || [])
      .filter((b) => !linkedIds.has(b.id))
      .map((b) => ({
        id: b.id,
        status: b.status,
        scheduled_start: b.scheduled_start,
        total_price: toNum(b.total_price),
        vehicle: [b.vehicles?.vehicle_make, b.vehicles?.vehicle_model].filter(Boolean).join(" ")
      }));

    const { data: auditRows } = await supabase
      .from("subscription_cycle_audit")
      .select("action, actor, cycle_id, booking_id, notes, before, after, created_at")
      .eq("subscription_id", subscription.id)
      .order("created_at", { ascending: false })
      .limit(30);

    const startDate = subscription.anchor_date || (subscription.created_at || "").slice(0, 10);
    const subscriptionAgeDays = startDate
      ? Math.max(0, Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(startDate + "T00:00:00Z")) / 86400000))
      : null;

    const vehicle = subscription.vehicles;
    const vehicleLabel = vehicle
      ? `${vehicle.vehicle_year || ""} ${vehicle.vehicle_make || ""} ${vehicle.vehicle_model || ""}`.trim()
      : "";
    const service = subscription.service_variants?.services;
    const serviceLabel = service
      ? `${service.category} Detail Level ${service.level}`
      : "Service";

    const nextService = await buildNextService(supabase, resolved, today);

    return res.status(200).json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        frequency: subscription.frequency,
        subscription_category: subscription.subscription_category,
        default_address: subscription.default_address,
        anchor_date: subscription.anchor_date,
        anchor_index_base: subscription.anchor_index_base ?? 0,
        pending_frequency: subscription.pending_frequency || null,
        pending_service_variant_id: subscription.pending_service_variant_id || null,
        activation_booking_id: subscription.activation_booking_id,
        activation_completed_at: subscription.activation_completed_at,
        discount_reset_required: subscription.discount_reset_required === true,
        created_at: subscription.created_at,
        customer_name: subscription.customers?.full_name ?? "",
        email: subscription.customers?.email ?? "",
        phone: subscription.customers?.phone ?? "",
        vehicle_summary: vehicleLabel,
        vehicle_size: vehicle?.vehicle_size || null,
        service_variant_id: subscription.service_variant_id || subscription.service_variants?.id || null,
        service_summary: serviceLabel,
        plan: planLabel(subscription)
      },
      next_service: nextService,
      active_cycle_id: activeCycle?.id || null,
      cycles: cycles.map((c) => {
        const link = activeLinkByCycle[c.id] || null;
        return {
          id: c.id,
          cycle_number: c.cycle_index + 1,
          cycle_index: c.cycle_index,
          status: c.status,
          window_start_date: c.window_start_date,
          window_end_date: c.window_end_date,
          effective_window_end: getEffectiveWindowEnd(c),
          opens_on: c.opens_on,
          pushback_used: c.pushback_used === true,
          free_pushback: c.free_pushback === true,
          pushback_end_date: c.pushback_end_date,
          resolved_by: c.resolved_by || null,
          booking: link?.bookings
            ? {
                id: link.bookings.id,
                status: link.bookings.status,
                scheduled_start: link.bookings.scheduled_start,
                total_price: toNum(link.bookings.total_price),
                price_mode: link.price_mode,
                pushback_fee_amount: link.pushback_fee_applied ? toNum(link.pushback_fee_amount) : 0,
                admin_override: link.admin_override === true
              }
            : null
        };
      }),
      unlinked_bookings: unlinkedBookings,
      audit: auditRows || [],
      metrics: {
        completed_cycles: cycles.filter((c) => c.status === "completed").length,
        missed_cycles: cycles.filter((c) => c.status === "missed").length,
        skipped_cycles: cycles.filter((c) => c.status === "void").length,
        subscription_age_days: subscriptionAgeDays,
        lifetime_value: Math.round(lifetimeValue * 100) / 100
      }
    });
  } catch (err) {
    console.error("admin-subscription-detail error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
