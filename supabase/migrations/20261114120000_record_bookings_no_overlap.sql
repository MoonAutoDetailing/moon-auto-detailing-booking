-- Records the double-booking guard that already exists on the live database
-- (it was created in the Supabase dashboard and was never in a migration).
-- Safe to run again: it does nothing if the constraint is already there.
create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_no_overlap') then
    alter table public.bookings
      add constraint bookings_no_overlap
      exclude using gist (tstzrange(scheduled_start, scheduled_end) with &&)
      where (status = any (array['pending'::text, 'confirmed'::text]));
  end if;
end $$;
