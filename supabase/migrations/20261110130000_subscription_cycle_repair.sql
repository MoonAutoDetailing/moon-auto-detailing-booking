-- Subscription cycle repair (Nov 2026).
-- Written against the live schema. Additive and backward-compatible: existing code keeps working.

-- Cycles: track when booking opens, which emails went out, and how each cycle was resolved.
alter table public.subscription_cycles
  add column if not exists opens_on date,
  add column if not exists open_email_sent_at timestamptz,
  add column if not exists missed_email_sent_at timestamptz,
  add column if not exists missed_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists resolved_by text;

-- "void" = cycle cancelled without penalty (pause/cancel, forgiven miss, admin void).
alter table public.subscription_cycles drop constraint if exists subscription_cycles_status_check;
alter table public.subscription_cycles
  add constraint subscription_cycles_status_check
  check (status = any (array['open'::text, 'booked'::text, 'completed'::text, 'missed'::text, 'void'::text]));

-- Cycle ↔ booking links keep history: a cancelled booking's link is released, not deleted,
-- so only one *active* link per cycle and per booking is enforced.
alter table public.subscription_cycle_bookings
  add column if not exists released_at timestamptz,
  add column if not exists admin_override boolean not null default false;

alter table public.subscription_cycle_bookings drop constraint if exists unique_cycle_booking;
alter table public.subscription_cycle_bookings drop constraint if exists unique_booking_cycle;
create unique index if not exists subscription_cycle_bookings_active_cycle
  on public.subscription_cycle_bookings (cycle_id) where released_at is null;
create unique index if not exists subscription_cycle_bookings_active_booking
  on public.subscription_cycle_bookings (booking_id) where released_at is null;

-- Subscriptions: re-anchoring (pause/resume, plan change) and plan changes that apply next cycle.
alter table public.subscriptions
  add column if not exists anchor_index_base integer not null default 0,
  add column if not exists pending_service_variant_id uuid references public.service_variants(id) on delete set null,
  add column if not exists pending_frequency text
    check (pending_frequency is null or pending_frequency = any (array['biweekly'::text, 'monthly'::text, 'quarterly'::text]));

-- Audit trail for every cycle/link/subscription state change made by the system or admin.
create table if not exists public.subscription_cycle_audit (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references public.subscriptions(id) on delete cascade,
  cycle_id uuid references public.subscription_cycles(id) on delete set null,
  booking_id uuid references public.bookings(id) on delete set null,
  action text not null,
  actor text not null default 'system',
  before jsonb,
  after jsonb,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_subscription_cycle_audit_subscription
  on public.subscription_cycle_audit (subscription_id, created_at);
alter table public.subscription_cycle_audit enable row level security;
