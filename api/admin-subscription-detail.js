import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd } from "./_subscriptions/lifecycle.js";
import { resolveSubscriptionById } from "./_subscriptions/resolveSubscriptionById.js";

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

    const { subscription, activeCycle, activeCycleBooking, history } = resolved;

    const effectiveWindowEnd = activeCycle ? getEffectiveWindowEnd(activeCycle) : null;

    const { data: allCycles } = await supabase
      .from("subscription_cycles")
      .select("id")
      .eq("subscription_id", subscription.id);
    const allCycleIds = (allCycles || []).map((c) => c.id);

    let cycleBookings = [];
    if (allCycleIds.length > 0) {
      const { data: links } = await supabase
        .from("subscription_cycle_bookings")
        .select(`
          id,
          cycle_id,
          booking_id,
          price_mode,
          pushback_fee_applied,
          pushback_fee_amount,
          bookings:booking_id (
            id,
            status,
            scheduled_start,
            total_price,
            base_price,
            travel_fee
          )
        `)
        .in("cycle_id", allCycleIds);
      cycleBookings = links || [];
    }

    let lifetimeValue = 0;
    const recentBookingHistory = [];
    (cycleBookings || []).forEach((scb) => {
      const b = scb.bookings;
      if (!b) return;
      const displayTotal = customerVisibleTotalForCycleBooking(b.total_price, scb);
      lifetimeValue += displayTotal;
      recentBookingHistory.push({
        id: b.id,
        status: b.status,
        scheduled_start: b.scheduled_start,
        total_price: toNum(b.total_price),
        pushback_fee_applied: scb.pushback_fee_applied,
        pushback_fee_amount: scb.pushback_fee_applied === true ? toNum(scb.pushback_fee_amount) : 0,
        display_total: displayTotal
      });
    });
    recentBookingHistory.sort((a, b) => (b.scheduled_start || "").localeCompare(a.scheduled_start || ""));
    const recentBookings = recentBookingHistory.slice(0, 10);

    const subscriptionAgeDays = subscription.created_at
      ? Math.floor((Date.now() - new Date(subscription.created_at).getTime()) / (24 * 60 * 60 * 1000))
      : null;

    const vehicle = subscription.vehicles;
    const vehicleLabel = vehicle
      ? `${vehicle.vehicle_year || ""} ${vehicle.vehicle_make || ""} ${vehicle.vehicle_model || ""}`.trim()
      : "";
    const service = subscription.service_variants?.services;
    const serviceLabel = service
      ? `${service.category} Detail Level ${service.level}`
      : "Service";

    return res.status(200).json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        frequency: subscription.frequency,
        subscription_category: subscription.subscription_category,
        default_address: subscription.default_address,
        anchor_date: subscription.anchor_date,
        activation_booking_id: subscription.activation_booking_id,
        activation_completed_at: subscription.activation_completed_at,
        discount_reset_required: subscription.discount_reset_required,
        completed_cycles_count: subscription.completed_cycles_count ?? 0,
        missed_cycles_count: subscription.missed_cycles_count ?? 0,
        vehicle_changed_since_anchor: subscription.vehicle_changed_since_anchor,
        created_at: subscription.created_at,
        updated_at: subscription.updated_at,
        customer_name: subscription.customers?.full_name ?? "",
        email: subscription.customers?.email ?? "",
        phone: subscription.customers?.phone ?? "",
        vehicle_summary: vehicleLabel,
        service_summary: serviceLabel
      },
      active_cycle: activeCycle
        ? {
            id: activeCycle.id,
            cycle_index: activeCycle.cycle_index,
            status: activeCycle.status,
            window_start_date: activeCycle.window_start_date,
            window_end_date: activeCycle.window_end_date,
            pushback_used: activeCycle.pushback_used,
            pushback_end_date: activeCycle.pushback_end_date,
            free_pushback: activeCycle.free_pushback,
            effective_window_end: effectiveWindowEnd
          }
        : null,
      active_cycle_booking: activeCycleBooking || null,
      history: (history || []).map((c) => ({
        ...c,
        effective_window_end: getEffectiveWindowEnd(c)
      })),
      recent_booking_history: recentBookings,
      metrics: {
        completed_cycles: subscription.completed_cycles_count ?? 0,
        missed_cycles: subscription.missed_cycles_count ?? 0,
        subscription_age_days: subscriptionAgeDays,
        lifetime_value: Math.round(lifetimeValue * 100) / 100
      }
    });
  } catch (err) {
    console.error("admin-subscription-detail error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
