-- Close two holes left open by views that run as their owner (postgres) and so bypass RLS.
--
--   * crm_customer_summary (created in the dashboard, not in a migration) was readable by the
--     public anon key: names, emails, phones, addresses, CRM notes and revenue for every customer.
--     Only the API reads it, with the service role, so anon/authenticated lose all access.
--   * booking_time_windows (20261111130000) is auto-updatable, and anon held INSERT/UPDATE/DELETE
--     on it, which wrote straight through to bookings. The booking wizard only needs SELECT
--     (index.html conflict check), so every other privilege is revoked.
--
-- Supabase grants new public relations to anon/authenticated by default; any new view over
-- customer, booking or money tables needs the same revoke (or security_invoker = on).

revoke all on public.crm_customer_summary from anon, authenticated;

revoke all on public.booking_time_windows from anon, authenticated;
grant select on public.booking_time_windows to anon, authenticated;
