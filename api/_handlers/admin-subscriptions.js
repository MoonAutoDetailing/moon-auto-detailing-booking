import verifyAdmin from "../_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import { getEffectiveWindowEnd, getBookingOpensDate, toNYDate, todayNY } from "../_subscriptions/lifecycle.js";
import { previewNextWindow } from "../_subscriptions/memberContext.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
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
    console.error("admin-subscriptions: auth failed", err.message);
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const status = (req.query.status || "").toString().trim();
    const frequency = (req.query.frequency || "").toString().trim();
    const q = (req.query.q || "").toString().trim();

    let query = supabase
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
        anchor_index_base,
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
      .order("created_at", { ascending: false });

    if (status) {
      query = query.eq("status", status);
    }
    if (frequency) {
      query = query.eq("frequency", frequency);
    }

    if (q) {
      const { data: customers } = await supabase
        .from("customers")
        .select("id")
        .or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`)
        .limit(500);
      const customerIds = (customers || []).map((c) => c.id);
      if (customerIds.length > 0) {
        query = query.in("customer_id", customerIds);
      } else {
        query = query.eq("customer_id", "00000000-0000-0000-0000-000000000000");
      }
    }

    const { data: subscriptions, error: subErr } = await query;
    if (subErr) {
      console.error("admin-subscriptions list error:", subErr);
      return res.status(500).json({ error: "Failed to load subscriptions" });
    }

    const list = subscriptions || [];
    const subIds = list.map((s) => s.id);
    if (subIds.length === 0) {
      return res.status(200).json({ subscriptions: [] });
    }

    const { data: cycles } = await supabase
      .from("subscription_cycles")
      .select("id, subscription_id, cycle_index, status, window_start_date, window_end_date, opens_on, pushback_used, pushback_end_date, free_pushback")
      .in("subscription_id", subIds);

    const cyclesBySub = {};
    (cycles || []).forEach((c) => {
      (cyclesBySub[c.subscription_id] ||= []).push(c);
    });

    const activeCycleIds = (cycles || []).filter((c) => c.status === "open" || c.status === "booked").map((c) => c.id);
    const linkByCycle = {};
    if (activeCycleIds.length > 0) {
      const { data: links } = await supabase
        .from("subscription_cycle_bookings")
        .select("cycle_id, booking_id, price_mode, bookings:booking_id(id, status, scheduled_start)")
        .is("released_at", null)
        .in("cycle_id", activeCycleIds);
      (links || []).forEach((l) => { linkByCycle[l.cycle_id] = l; });
    }

    const today = todayNY();
    const payload = list.map((sub) => {
      const subCycles = (cyclesBySub[sub.id] || []).sort((a, b) => b.cycle_index - a.cycle_index);
      const activeCycle = subCycles.find((c) => c.status === "open" || c.status === "booked") || null;
      const effectiveWindowEnd = activeCycle ? getEffectiveWindowEnd(activeCycle) : null;
      const link = activeCycle ? linkByCycle[activeCycle.id] : null;
      const vehicle = sub.vehicles;
      const vehicleLabel = vehicle
        ? `${vehicle.vehicle_year || ""} ${vehicle.vehicle_make || ""} ${vehicle.vehicle_model || ""}`.trim()
        : "";
      const service = sub.service_variants?.services;
      const serviceLabel = service
        ? `${service.category} Detail Level ${service.level}`
        : "Service";

      // What needs the owner's attention, most urgent first.
      const flags = [];
      if (sub.status === "active" && activeCycle) {
        const bookingDay = link?.bookings?.scheduled_start ? toNYDate(link.bookings.scheduled_start) : null;
        if (link && bookingDay && bookingDay < today && link.bookings.status !== "completed") flags.push("needs_completion");
        if (!link && activeCycle.status === "open" && today > effectiveWindowEnd) flags.push("overdue");
        const opensOn = activeCycle.opens_on || getBookingOpensDate(activeCycle.window_start_date);
        if (!link && activeCycle.status === "open" && today >= opensOn && today <= effectiveWindowEnd) flags.push("awaiting_booking");
      }
      if (sub.discount_reset_required) flags.push("discount_lost");
      if (activeCycle?.pushback_used) flags.push(activeCycle.free_pushback ? "extended_free" : "extended_paid");

      const next = !activeCycle && sub.status === "active" ? previewNextWindow(sub, subCycles, today) : null;
      return {
        id: sub.id,
        customer_name: sub.customers?.full_name ?? "",
        email: sub.customers?.email ?? "",
        phone: sub.customers?.phone ?? "",
        vehicle_summary: vehicleLabel,
        service_summary: serviceLabel,
        frequency: sub.frequency,
        status: sub.status,
        anchor_date: sub.anchor_date,
        discount_reset_required: sub.discount_reset_required === true,
        completed_cycles_count: subCycles.filter((c) => c.status === "completed").length,
        missed_cycles_count: subCycles.filter((c) => c.status === "missed").length,
        flags,
        active_cycle: activeCycle
          ? {
              id: activeCycle.id,
              cycle_number: activeCycle.cycle_index + 1,
              status: activeCycle.status,
              window_start_date: activeCycle.window_start_date,
              window_end_date: activeCycle.window_end_date,
              effective_window_end: effectiveWindowEnd,
              pushback_used: activeCycle.pushback_used === true,
              has_booking: Boolean(link),
              booking_start: link?.bookings?.scheduled_start || null,
              booking_status: link?.bookings?.status || null
            }
          : null,
        next_window: next ? { start: next.start, end: next.end, opens_on: next.opensOn } : null
      };
    });

    return res.status(200).json({ subscriptions: payload });
  } catch (err) {
    console.error("admin-subscriptions error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
