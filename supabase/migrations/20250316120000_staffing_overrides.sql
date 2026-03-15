-- Date-level staffing overrides: Solo Mode flag per date.
-- When solo_mode is true, effective duration uses service-specific multiplier + 15 min buffer.

create table if not exists public.staffing_overrides (
  override_date date primary key,
  solo_mode boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.staffing_overrides is 'Admin date-level overrides: Solo Mode enables service-specific duration multiplier + buffer for availability and booking end time.';
