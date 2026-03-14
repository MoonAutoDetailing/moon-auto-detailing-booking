-- Extend availability_overrides for time_range scope (v2 partial-day).
-- One override per date; full_day => null times; time_range => required start_time < end_time.

alter table public.availability_overrides
  drop constraint if exists availability_overrides_scope_check;

alter table public.availability_overrides
  add constraint availability_overrides_scope_check
  check (scope in ('full_day', 'time_range'));

alter table public.availability_overrides
  add constraint availability_overrides_times_check
  check (
    (scope = 'full_day' and start_time is null and end_time is null)
    or
    (scope = 'time_range' and start_time is not null and end_time is not null and start_time < end_time)
  );

drop index if exists public.availability_overrides_full_day_unique;

create unique index availability_overrides_date_unique
  on public.availability_overrides (override_date);

comment on column public.availability_overrides.scope is 'full_day: whole day; time_range: partial day using start_time/end_time.';
