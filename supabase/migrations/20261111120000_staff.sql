-- Team accounts: owner, managers and employees each get their own login.
-- Passwords and clock-in PINs are scrypt hashes produced by api/_staffAuth.js
-- (format "scrypt$<salt hex>$<hash hex>"); plain values are never stored.
create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null,
  phone text,
  role text not null default 'employee'
    check (role in ('owner', 'manager', 'employee')),
  hourly_rate numeric(10, 2),
  password_hash text,
  pin_hash text,
  active boolean not null default true,
  must_change_password boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.staff (id)
);

create unique index if not exists staff_email_lower_key
  on public.staff (lower(email));

create index if not exists idx_staff_role_active
  on public.staff (role, active);

-- Only the service role (API functions) reads/writes; no anon policies.
alter table public.staff enable row level security;
