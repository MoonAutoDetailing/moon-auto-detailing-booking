-- Close row-level-security holes on the publishable (anon) key.
--
-- APPLY ONLY AFTER the admin.html change that stops writing bookings with the anon
-- client is deployed to production (reschedule_requested now goes through
-- /api/admin-request-reschedule; realtime is replaced by polling /api/admin-bookings).
--
-- Before this migration anyone holding the key embedded in index.html could:
--   * read every booking (incl. manage_token, address, prices) and update any booking
--     ("service_role_*" policies were granted to role "public" with USING true;
--      the service role bypasses RLS and never needed them);
--   * read every customer record;
--   * pass a hardcoded header value ('moon-admin-2026') to unlock admin policies.
--
-- What the public site still needs, and keeps:
--   * bookings_insert_anon, customers_insert_anon, vehicles_insert_anon (wizard inserts)
--   * customers_select_by_email_header_anon (wizard looks up a returning customer)
--   * services / service_variants public reads (price list)
--   * booking_time_windows (start/end only) for the wizard's conflict check, now served by
--     a definer view so the anon role needs no SELECT on bookings at all.

begin;

drop policy if exists "service_role_read_bookings" on public.bookings;
drop policy if exists "service_role_update_bookings" on public.bookings;
drop policy if exists "Public read booking by manage token" on public.bookings;
drop policy if exists "admin_update_booking_status" on public.bookings;
drop policy if exists "admin_read_pending_bookings" on public.bookings;

drop policy if exists "service_role_read_customers" on public.customers;
drop policy if exists "admin_read_customers" on public.customers;

drop policy if exists "admin_read_vehicles" on public.vehicles;
drop policy if exists "admin_read_services" on public.services;
drop policy if exists "admin_read_service_variants" on public.service_variants;

-- The view exposes only two timestamp columns; running it as its owner lets the
-- wizard check conflicts without any anon SELECT policy on bookings.
alter view public.booking_time_windows set (security_invoker = off);
grant select on public.booking_time_windows to anon, authenticated;

drop policy if exists "bookings_select_time_window_anon" on public.bookings;

commit;
