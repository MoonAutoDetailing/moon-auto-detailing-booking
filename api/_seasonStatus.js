// Off-season switch. While closed, only active maintenance members (identified by
// their subscription portal token) can create bookings; everyone else joins the waitlist.
// To reopen in the spring: set SEASON_CLOSED_DEFAULT to false, or set the Vercel env var
// BOOKING_SEASON_CLOSED=false (env var wins when present).
const SEASON_CLOSED_DEFAULT = true;

export const SEASON_CLOSED_MESSAGE =
  "We're closed for the season. Through the winter we're only servicing vehicles enrolled in our Maintenance Programs. Join the waitlist and we'll reach out in the spring.";

export function isSeasonClosed() {
  const env = process.env.BOOKING_SEASON_CLOSED;
  if (env === "false") return false;
  if (env === "true") return true;
  return SEASON_CLOSED_DEFAULT;
}

/**
 * True when memberToken (the token on the member's subscription portal link) belongs to an
 * active subscription. Mirrors the lookup in _subscriptions/resolveSubscriptionByToken.js.
 */
export async function isActiveMemberToken(supabase, memberToken) {
  if (!memberToken || typeof memberToken !== "string") return false;
  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .select("id")
    .eq("manage_token", memberToken)
    .maybeSingle();
  if (bookingErr || !booking) return false;
  const { data: subscription, error: subErr } = await supabase
    .from("subscriptions")
    .select("id, status")
    .eq("activation_booking_id", booking.id)
    .maybeSingle();
  if (subErr || !subscription) return false;
  return subscription.status === "active";
}
