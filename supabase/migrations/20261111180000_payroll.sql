-- Weekly payroll. One run per Monday–Sunday pay week:
--   draft    → recalculated from the time clock, tips and pay-backs every time it's opened
--   approved → numbers frozen for review/payment (can be reopened)
--   paid     → locked; pay-back expenses are stamped reimbursed
create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  week_end date not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'paid')),
  approved_by text,
  approved_at timestamptz,
  paid_by text,
  paid_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.payroll_runs enable row level security;

create table if not exists public.payroll_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs (id) on delete cascade,
  staff_id uuid not null references public.staff (id),
  hourly_rate numeric(10, 2),
  regular_hours numeric(8, 2) not null default 0,
  overtime_hours numeric(8, 2) not null default 0,
  regular_pay numeric(10, 2) not null default 0,
  overtime_pay numeric(10, 2) not null default 0,
  tips numeric(10, 2) not null default 0,
  reimbursements numeric(10, 2) not null default 0,
  total numeric(10, 2) not null default 0,
  payment_method text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, staff_id)
);
create index if not exists idx_payroll_lines_staff on public.payroll_lines (staff_id);
alter table public.payroll_lines enable row level security;

-- Which payroll paid back a crew member's own-money expense.
alter table public.expenses
  add column if not exists payroll_run_id uuid references public.payroll_runs (id);
