import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd } from "./_subscriptions/lifecycle.js";
import { resolveSubscriptionByToken } from "./_subscriptions/resolveSubscriptionByToken.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ error: "Missing token" });
    }

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const resolved = await resolveSubscriptionByToken(supabase, token);
    if (resolved.error) {
      return res.status(resolved.status || 500).json({ error: resolved.error });
    }

    const { subscription, activeCycle, activeCycleBooking, history } = resolved;

    const toNum = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    };
    const roundMoney = (n) => Math.round(n * 100) / 100;

    const service = subscription.service_variants?.services;
    const vehicle = subscription.vehicles;

    const serviceLabel = service
      ? `${service.category} Detail Level ${service.level}`
      : "Service";

    const vehicleLabel = vehicle
      ? `${vehicle.vehicle_year || ""} ${vehicle.vehicle_make || ""} ${vehicle.vehicle_model || ""}`.trim()
      : "";

    const effectiveWindowEnd = activeCycle ? getEffectiveWindowEnd(activeCycle) : null;
    const canPushback = !!(
      activeCycle &&
      activeCycle.status === "open" &&
      !activeCycle.pushback_used &&
      !activeCycleBooking
    );

    const canCancelSubscription = (subscription.completed_cycles_count ?? 0) >= 3;

    let bookingPricing = null;
    if (activeCycleBooking) {
      const bookingBasePrice = toNum(activeCycleBooking.bookings?.base_price);
      const bookingTravelFee = toNum(activeCycleBooking.bookings?.travel_fee);
      const bookingStoredTotal = toNum(activeCycleBooking.bookings?.total_price);
      const pushbackFeeApplied = activeCycleBooking.pushback_fee_applied === true;
      const pushbackFeeAmount = pushbackFeeApplied ? toNum(activeCycleBooking.pushback_fee_amount) : 0;
      const displaySubtotal = roundMoney(bookingBasePrice + bookingTravelFee);
      const displayTotal = roundMoney(bookingBasePrice + bookingTravelFee + pushbackFeeAmount);
      const storedTotalMatchesDisplayTotal = roundMoney(bookingStoredTotal) === displayTotal;
      bookingPricing = {
        base_price: bookingBasePrice,
        travel_fee: bookingTravelFee,
        pushback_fee_applied: pushbackFeeApplied,
        pushback_fee_amount: pushbackFeeAmount,
        subtotal_before_pushback_fee: displaySubtotal,
        stored_booking_total: roundMoney(bookingStoredTotal),
        display_total: displayTotal,
        stored_total_matches_display_total: storedTotalMatchesDisplayTotal
      };
    }

    return res.status(200).json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        frequency: subscription.frequency,
        subscription_category: subscription.subscription_category,
        default_address: subscription.default_address,
        anchor_date: subscription.anchor_date,
        activation_booking_id: subscription.activation_booking_id,
        discount_reset_required: subscription.discount_reset_required,
        completed_cycles_count: subscription.completed_cycles_count,
        missed_cycles_count: subscription.missed_cycles_count,
        vehicle_changed_since_anchor: subscription.vehicle_changed_since_anchor,
        customer_name: subscription.customers?.full_name ?? "",
        email: subscription.customers?.email ?? "",
        phone: subscription.customers?.phone ?? "",
        vehicle: vehicleLabel,
        service: serviceLabel
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
            effective_window_end: effectiveWindowEnd,
            can_pushback: canPushback
          }
        : null,
      active_cycle_booking: activeCycleBooking
        ? {
            id: activeCycleBooking.id,
            cycle_id: activeCycleBooking.cycle_id,
            booking_id: activeCycleBooking.booking_id,
            price_mode: activeCycleBooking.price_mode,
            pushback_fee_applied: activeCycleBooking.pushback_fee_applied,
            pushback_fee_amount: activeCycleBooking.pushback_fee_amount,
            booking: activeCycleBooking.bookings || null,
            pricing: bookingPricing
          }
        : null,
      history: history.map((cycle) => ({
        id: cycle.id,
        cycle_index: cycle.cycle_index,
        status: cycle.status,
        window_start_date: cycle.window_start_date,
        window_end_date: cycle.window_end_date,
        pushback_used: cycle.pushback_used,
        pushback_end_date: cycle.pushback_end_date,
        effective_window_end: getEffectiveWindowEnd(cycle)
      })),
      actions: {
        can_cancel_subscription: canCancelSubscription
      }
    });
  } catch (err) {
    console.error("get-subscription-by-token error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
