/**
 * What a member's next service looks like right now, in one shape shared by the member portal
 * (get-subscription-by-token) and the member booking page (get-member-booking-context).
 *
 * phase:
 *   upcoming   window not open for booking yet (opens_on in the future)
 *   bookable   booking is open and the member hasn't booked
 *   booked     an appointment is attached to this cycle
 *   overdue    the window has ended without a booking (will be resolved overnight)
 *   paused | cancelled | pending_activation   plan not active
 */
import {
  computeCycleWindow,
  getBookingOpensDate,
  getEffectiveWindowEnd,
  getPushbackEnd,
  todayNY
} from "./lifecycle.js";
import { normalizePlanCategory, pushbackFeeFor, resolveMemberPrice } from "./cycleState.js";

const MAX_SKIP = 400;

/** Next window for a subscription that has no open/booked cycle yet. */
export function previewNextWindow(subscription, history, today) {
  if (!subscription.anchor_date) return null;
  const maxIndex = history.reduce((m, c) => Math.max(m, c.cycle_index ?? 0), 0);
  let index = maxIndex + 1;
  let win = computeCycleWindow(subscription.anchor_date, subscription.frequency, index, subscription.anchor_index_base || 0);
  for (let i = 0; win && win.end < today && i < MAX_SKIP; i++) {
    index += 1;
    win = computeCycleWindow(subscription.anchor_date, subscription.frequency, index, subscription.anchor_index_base || 0);
  }
  return win ? { cycle_index: index, ...win } : null;
}

export function planLabel(subscription) {
  const service = subscription.service_variants?.services;
  const category = subscription.subscription_category || normalizePlanCategory(service?.category);
  const categoryLabel = { combined: "Interior + Exterior", interior: "Interior", exterior: "Exterior" }[category] || service?.category || "Maintenance";
  const freqLabel = { biweekly: "Every 2 weeks", monthly: "Monthly", quarterly: "Every 3 months" }[subscription.frequency] || subscription.frequency;
  return { category, categoryLabel, frequency: subscription.frequency, frequencyLabel: freqLabel };
}

export function vehicleLabel(subscription) {
  const v = subscription.vehicles || {};
  return [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(" ") || "Your vehicle";
}

/**
 * resolved = result of resolveSubscriptionByToken / resolveSubscriptionById.
 */
export async function buildNextService(sb, resolved, today = todayNY()) {
  const { subscription, activeCycle, activeCycleBooking, history = [] } = resolved;
  const variant = subscription.service_variants || {};
  const priceVariant = {
    price: variant.price,
    vehicle_size: subscription.vehicles?.vehicle_size,
    service: variant.services
  };
  const price = await resolveMemberPrice(sb, subscription, priceVariant);

  if (subscription.status !== "active") {
    return { phase: subscription.status, price };
  }

  if (!activeCycle) {
    const next = previewNextWindow(subscription, history, today);
    return {
      phase: "upcoming",
      cycle_id: null,
      cycle_number: next ? next.cycle_index + 1 : null,
      window_start: next?.start || null,
      window_end: next?.end || null,
      effective_end: next?.end || null,
      opens_on: next?.opensOn || null,
      pushback: { used: false, available: false },
      booking: null,
      price
    };
  }

  const effectiveEnd = getEffectiveWindowEnd(activeCycle);
  const opensOn = activeCycle.opens_on || getBookingOpensDate(activeCycle.window_start_date);
  const linked = activeCycleBooking?.bookings || null;
  let phase;
  if (activeCycle.status === "booked" || linked) phase = "booked";
  else if (today < opensOn) phase = "upcoming";
  else if (today > effectiveEnd) phase = "overdue";
  else phase = "bookable";

  const fee = pushbackFeeFor({ ...activeCycle, pushback_used: true, free_pushback: false }, price.base_price);
  return {
    phase,
    cycle_id: activeCycle.id,
    cycle_number: (activeCycle.cycle_index ?? 0) + 1,
    window_start: activeCycle.window_start_date,
    window_end: activeCycle.window_end_date,
    effective_end: effectiveEnd,
    opens_on: opensOn,
    pushback: {
      used: activeCycle.pushback_used === true,
      free: activeCycle.free_pushback === true,
      end: activeCycle.pushback_end_date || null,
      // One pushback per cycle, only once the window has started and before it ends, unbooked.
      available: phase === "bookable" && !activeCycle.pushback_used && today >= activeCycle.window_start_date,
      would_extend_to: activeCycle.pushback_used ? null : getPushbackEnd(effectiveEnd),
      fee_if_paid: fee.pushback_fee_amount
    },
    booking: linked
      ? {
          id: linked.id,
          status: linked.status,
          scheduled_start: linked.scheduled_start,
          scheduled_end: linked.scheduled_end,
          service_address: linked.service_address,
          total_price: linked.total_price,
          base_price: linked.base_price,
          travel_fee: linked.travel_fee,
          manage_token: linked.manage_token
        }
      : null,
    price: {
      ...price,
      pushback_fee: activeCycle.pushback_used && !activeCycle.free_pushback ? pushbackFeeFor(activeCycle, price.base_price).pushback_fee_amount : 0
    }
  };
}
