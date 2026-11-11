-- Crew scheduling: shifts built by managers, availability set by each person, and
-- time-off requests managers approve. Dates are New York calendar dates; times are local.

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff (id),
  shift_date date not null,
  start_time time not null,
  end_time time not null,
  notes text,
  published boolean not null default false,
  published_at timestamptz,
  morning_email_sent_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shifts_end_after_start check (end_time > start_time)
);
create index if not exists idx_shifts_date on public.shifts (shift_date);
create index if not exists idx_shifts_staff_date on public.shifts (staff_id, shift_date);
alter table public.shifts enable row level security;

-- Either a weekly rule (weekday 0=Sunday … 6=Saturday) or a one-day exception (on_date).
-- start/end null with available=true means "all day".
create table if not exists public.staff_availability (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff (id) on delete cascade,
  weekday smallint check (weekday between 0 and 6),
  on_date date,
  available boolean not null,
  start_time time,
  end_time time,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_availability_one_kind check ((weekday is null) <> (on_date is null)),
  constraint staff_availability_times check (start_time is null or end_time is null or end_time > start_time)
);
create unique index if not exists staff_availability_weekly_key
  on public.staff_availability (staff_id, weekday) where weekday is not null;
create unique index if not exists staff_availability_date_key
  on public.staff_availability (staff_id, on_date) where on_date is not null;
alter table public.staff_availability enable row level security;

create table if not exists public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff (id) on delete cascade,
  start_date date not null,
  end_date date not null,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'cancelled')),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  constraint time_off_dates check (end_date >= start_date)
);
create index if not exists idx_time_off_staff on public.time_off_requests (staff_id, start_date);
alter table public.time_off_requests enable row level security;
