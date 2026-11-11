-- Time clock. One row per shift segment (clock-in → clock-out). Clock-in is verified by
-- GPS (near a job that day or the base address) or a manager/owner PIN; managers can add or
-- correct entries, and every correction is kept in time_entry_edits.
create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff (id),
  clock_in_at timestamptz not null,
  clock_out_at timestamptz,
  in_lat double precision,
  in_lng double precision,
  in_accuracy_m double precision,
  in_distance_m double precision,
  in_site text,
  out_lat double precision,
  out_lng double precision,
  out_accuracy_m double precision,
  out_distance_m double precision,
  verify_method text not null check (verify_method in ('gps', 'pin', 'manager')),
  verified_by uuid references public.staff (id),
  notes text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_entries_out_after_in check (clock_out_at is null or clock_out_at > clock_in_at)
);

-- At most one open (not clocked out, not voided) entry per person.
create unique index if not exists time_entries_one_open_per_staff
  on public.time_entries (staff_id)
  where clock_out_at is null and voided_at is null;

create index if not exists idx_time_entries_staff_in on public.time_entries (staff_id, clock_in_at);
create index if not exists idx_time_entries_in on public.time_entries (clock_in_at);
alter table public.time_entries enable row level security;

create table if not exists public.time_entry_edits (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.time_entries (id) on delete cascade,
  edited_by text not null,
  action text not null check (action in ('create', 'update', 'void')),
  before jsonb,
  after jsonb,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_time_entry_edits_entry on public.time_entry_edits (entry_id);
alter table public.time_entry_edits enable row level security;
