import { createClient } from "@supabase/supabase-js";
import verifyAdmin from "./_verifyAdmin.js";
import { createBookingCore } from "./_createBookingCore.js";
import { confirmBookingCore } from "./_confirmBookingCore.js";
import { sendBookingCreatedEmailCore } from "../lib/email/sendBookingCreatedEmail.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const FORBIDDEN_FIELDS = [
  "discount_code",
  "subscription_id",
  "subscription_mode",
  "subscription_category",
  "subscription_frequency",
  "base_price",
  "travel_fee",
  "travel_minutes",
  "total_price",
  "allowAvailabilityOverride",
  "manage_token",
  "google_event_id",
  "google_event_html_link",
  "custom_service_label"
];

function parseAdminPriceOverride(body) {
  const hasCustomEnabled = Object.prototype.hasOwnProperty.call(body || {}, "custom_price_enabled");
  const hasCustomBase = Object.prototype.hasOwnProperty.call(body || {}, "custom_base_price");
  const enabledRaw = body?.custom_price_enabled;
  const enabled = enabledRaw === true || enabledRaw === "true";

  if (hasCustomEnabled && enabledRaw !== true && enabledRaw !== false && enabledRaw !== "true" && enabledRaw !== "false") {
    return { ok: false, message: "Custom price enabled must be true or false." };
  }

  if (!enabled) {
    if (hasCustomBase) {
      return { ok: false, message: "Custom base price requires custom pricing to be enabled." };
    }
    return { ok: true, override: null };
  }

  const rawCustomBasePrice = body?.custom_base_price;
  const customBasePrice = Number(rawCustomBasePrice);
  if (!Number.isFinite(customBasePrice) || customBasePrice <= 0) {
    return { ok: false, message: "Custom base price must be greater than 0." };
  }

  return {
    ok: true,
    override: {
      base_price: Math.round(customBasePrice * 100) / 100
    }
  };
}

export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    for (const field of FORBIDDEN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        return res.status(400).json({ ok: false, error: `${field} is not supported for admin booking v1` });
      }
    }

    const priceOverrideResult = parseAdminPriceOverride(req.body || {});
    if (!priceOverrideResult.ok) {
      console.warn("[ADMIN_CREATE_BOOKING] invalid_custom_price");
      return res.status(400).json({ ok: false, message: priceOverrideResult.message });
    }

    const requestedStatus = req.body?.status || "confirmed";
    if (!["confirmed", "pending"].includes(requestedStatus)) {
      return res.status(400).json({ ok: false, error: "status must be confirmed or pending" });
    }
    const sendCustomerEmail = req.body?.send_customer_email !== false;
    const adminManualTime = req.body?.admin_manual_time === true;

    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    const customerId = String(req.body?.customer_id || "").trim();
    const vehicleId = String(req.body?.vehicle_id || "").trim();

    const { data: vehicle, error: vehicleErr } = await supabase
      .from("vehicles")
      .select("id, customer_id")
      .eq("id", vehicleId)
      .maybeSingle();

    if (vehicleErr) throw vehicleErr;
    if (!vehicle || vehicle.customer_id !== customerId) {
      return res.status(400).json({ ok: false, error: "Vehicle does not belong to customer" });
    }

    const {
      custom_price_enabled,
      custom_base_price,
      ...safeBookingBody
    } = req.body || {};
    let bookingBody = safeBookingBody;
    if (adminManualTime) {
      const { data: variant, error: variantErr } = await supabase
        .from("service_variants")
        .select("duration_minutes")
        .eq("id", req.body?.service_variant_id)
        .maybeSingle();
      if (variantErr) throw variantErr;

      const durationMinutes = Number(variant?.duration_minutes);
      const manualStart = new Date(req.body?.scheduled_start);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        return res.status(400).json({ ok: false, error: "Selected service is missing a valid duration" });
      }
      if (Number.isNaN(manualStart.getTime())) {
        return res.status(400).json({ ok: false, error: "scheduled_start is invalid" });
      }

      bookingBody = {
        ...bookingBody,
        scheduled_end: new Date(manualStart.getTime() + durationMinutes * 60000).toISOString()
      };
    }

    const result = await createBookingCore({
      body: bookingBody,
      status: "pending",
      allowDiscount: false,
      allowSubscription: false,
      allowAvailabilityOverride: adminManualTime,
      adminPriceOverride: priceOverrideResult.override
    });

    if (!result.ok) {
      return res.status(result.statusCode).json(result.body);
    }

    const booking = result.booking;

    if (requestedStatus === "pending") {
      if (sendCustomerEmail) {
        try {
          await sendBookingCreatedEmailCore(booking.id);
        } catch (emailErr) {
          console.error("[EMAIL] type=booking-created booking_id=" + booking.id + " status=failure", emailErr);
        }
      }
      console.log("[ADMIN_BOOKING] created status=pending booking_id=" + booking.id);
      return res.status(200).json({
        ok: true,
        bookingId: booking.id,
        status: "pending",
        manage_token: booking.manage_token
      });
    }

    const confirmResult = await confirmBookingCore({
      bookingId: booking.id,
      sendCustomerEmail
    });

    if (!confirmResult.ok) {
      if (confirmResult.body?.message?.toLowerCase().includes("email")) {
        console.error("[EMAIL] type=booking-confirmed booking_id=" + booking.id + " status=failure");
      }
      await supabase
        .from("bookings")
        .delete()
        .eq("id", booking.id)
        .is("google_event_id", null);
      return res.status(confirmResult.statusCode).json(confirmResult.body);
    }

    console.log("[ADMIN_BOOKING] created status=confirmed booking_id=" + booking.id);
    return res.status(200).json({
      ok: true,
      bookingId: booking.id,
      status: "confirmed",
      manage_token: booking.manage_token
    });
  } catch (err) {
    console.error("admin-create-booking error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
