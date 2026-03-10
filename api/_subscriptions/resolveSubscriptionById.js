/**
 * Resolve a subscription by id (admin use). Same shape as resolveSubscriptionByToken
 * but keyed by subscription id; no activationBooking (use activation_booking_id if needed).
 */
export async function resolveSubscriptionById(supabase, subscriptionId) {
  if (!subscriptionId) {
    return { error: "Missing subscription id", status: 400 };
  }

  const { data: subscription, error: subErr } = await supabase
    .from("subscriptions")
    .select(`
      id,
      customer_id,
      vehicle_id,
      service_variant_id,
      default_address,
      frequency,
      status,
      anchor_date,
      activation_booking_id,
      activation_completed_at,
      discount_reset_required,
      completed_cycles_count,
      missed_cycles_count,
      vehicle_changed_since_anchor,
      subscription_category,
      created_at,
      updated_at,
      customers:customer_id (
        full_name,
        email,
        phone
      ),
      vehicles:vehicle_id (
        vehicle_size,
        vehicle_year,
        vehicle_make,
        vehicle_model,
        license_plate
      ),
      service_variants:service_variant_id (
        id,
        price,
        duration_minutes,
        services:service_id (
          category,
          level
        )
      )
    `)
    .eq("id", subscriptionId)
    .maybeSingle();

  if (subErr) {
    return { error: "Failed to load subscription", status: 500 };
  }

  if (!subscription) {
    return { error: "Subscription not found", status: 404 };
  }

  const { data: activeCycle, error: cycleErr } = await supabase
    .from("subscription_cycles")
    .select(`
      id,
      subscription_id,
      cycle_index,
      status,
      window_start_date,
      window_end_date,
      pushback_used,
      pushback_end_date,
      free_pushback,
      created_at,
      updated_at
    `)
    .eq("subscription_id", subscription.id)
    .in("status", ["open", "booked"])
    .order("cycle_index", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cycleErr) {
    return { error: "Failed to load active cycle", status: 500 };
  }

  let activeCycleBooking = null;
  if (activeCycle) {
    const { data: linkedBooking, error: linkedErr } = await supabase
      .from("subscription_cycle_bookings")
      .select(`
        id,
        cycle_id,
        booking_id,
        price_mode,
        pushback_fee_applied,
        pushback_fee_amount,
        created_at,
        bookings:booking_id (
          id,
          status,
          scheduled_start,
          scheduled_end,
          service_address,
          google_event_html_link,
          base_price,
          travel_fee,
          total_price,
          travel_minutes,
          manage_token
        )
      `)
      .eq("cycle_id", activeCycle.id)
      .maybeSingle();

    if (linkedErr) {
      return { error: "Failed to load cycle booking", status: 500 };
    }

    activeCycleBooking = linkedBooking || null;
  }

  const { data: history, error: historyErr } = await supabase
    .from("subscription_cycles")
    .select(`
      id,
      subscription_id,
      cycle_index,
      status,
      window_start_date,
      window_end_date,
      pushback_used,
      pushback_end_date,
      free_pushback,
      created_at,
      updated_at
    `)
    .eq("subscription_id", subscription.id)
    .order("cycle_index", { ascending: false })
    .limit(12);

  if (historyErr) {
    return { error: "Failed to load subscription history", status: 500 };
  }

  return {
    subscription,
    activeCycle: activeCycle || null,
    activeCycleBooking,
    history: history || [],
    status: 200
  };
}
