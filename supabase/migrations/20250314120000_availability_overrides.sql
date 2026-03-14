-- Availability overrides: admin-only full-day open/block per date.
-- v1: full_day only; start_time/end_time null. Designed for future partial-day without redesign.

create table if not exists public.availability_overrides (
  id uuid primary key default gen_random_uuid(),
  override_date date not null,
  mode text not null check (mode in ('open', 'blocked')),
  scope text not null default 'full_day' check (scope in ('full_day')),
  start_time time,
  end_time time,
  reason text,
  google_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One full-day override per date.
create unique index availability_overrides_full_day_unique
  on public.availability_overrides (override_date)
  where scope = 'full_day';

comment on table public.availability_overrides is 'Admin date-level overrides: open normally closed days (e.g. weekend) or block normally open days. DB is source of truth; Google Calendar block events mirrored for blocked full-day only.';
