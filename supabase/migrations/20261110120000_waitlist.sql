-- Off-season waitlist: people to contact when booking reopens in the spring.
create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  phone text,
  interest text not null default 'maintenance_plan'
    check (interest in ('maintenance_plan', 'one_time_detail')),
  preferred_plan text,
  vehicle text,
  notes text,
  source text default 'booking_page',
  contacted boolean not null default false,
  contacted_at timestamptz,
  created_at timestamptz default now(),
  constraint waitlist_contact_present check (
    coalesce(nullif(trim(email), ''), nullif(trim(phone), '')) is not null
  )
);

create index if not exists idx_waitlist_created_at
  on public.waitlist (created_at);

create index if not exists idx_waitlist_contacted
  on public.waitlist (contacted);

-- Only the service role (API functions) reads/writes; no anon policies.
alter table public.waitlist enable row level security;
