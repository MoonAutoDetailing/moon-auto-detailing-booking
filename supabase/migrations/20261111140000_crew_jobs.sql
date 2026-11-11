-- Crew app: job flags/notes, who worked a job, step checklists, QC photos.
-- Additive only. Photos live in the private Storage bucket "job-media"; the API hands out
-- short-lived signed URLs, so no Storage policies are needed for anon/authenticated.

alter table public.bookings
  add column if not exists job_flag text
    check (job_flag is null or job_flag in ('ceramic')),
  add column if not exists crew_notes text;

-- Who worked each job (tip split + payroll later). One row per person per booking.
create table if not exists public.booking_staff (
  booking_id uuid not null references public.bookings (id) on delete cascade,
  staff_id uuid not null references public.staff (id),
  created_at timestamptz not null default now(),
  primary key (booking_id, staff_id)
);
create index if not exists idx_booking_staff_staff on public.booking_staff (staff_id);
alter table public.booking_staff enable row level security;

-- Checklist steps. A booking gets: 'general' steps always; 'interior' and/or 'exterior'
-- steps from its service category with min_level <= its level; 'ceramic' steps when
-- bookings.job_flag = 'ceramic'. Owners edit these from the admin page.
create table if not exists public.service_checklists (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('general', 'interior', 'exterior', 'ceramic')),
  min_level smallint not null default 1,
  step_order integer not null default 0,
  text text not null,
  required boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_service_checklists_scope on public.service_checklists (scope, active, step_order);
alter table public.service_checklists enable row level security;

-- One row per booking once the crew starts it.
create table if not exists public.job_completions (
  booking_id uuid primary key references public.bookings (id) on delete cascade,
  started_at timestamptz,
  started_by uuid references public.staff (id),
  completed_at timestamptz,
  completed_by uuid references public.staff (id),
  checklist jsonb not null default '{}'::jsonb,
  notes text,
  updated_at timestamptz not null default now()
);
alter table public.job_completions enable row level security;

create table if not exists public.job_photos (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  staff_id uuid references public.staff (id),
  kind text not null check (kind in ('before', 'after', 'issue')),
  storage_path text not null unique,
  caption text,
  taken_at timestamptz not null default now()
);
create index if not exists idx_job_photos_booking on public.job_photos (booking_id, kind);
alter table public.job_photos enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-media', 'job-media', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

-- Starter checklists, taken from the package descriptions on the booking page.
insert into public.service_checklists (scope, min_level, step_order, text, required)
select * from (values
  ('general', 1, 10, 'Confirm the service, vehicle and any special requests with the customer', true),
  ('general', 1, 20, 'Walk around the vehicle and photograph any existing damage as an Issue photo', true),
  ('general', 1, 90, 'Final walkaround: glass, door jambs, wheels, missed spots', true),
  ('general', 1, 95, 'Show the customer the finished vehicle', true),

  ('interior', 1, 10, 'Remove trash and personal items (set belongings aside for the customer)', true),
  ('interior', 1, 20, 'Vacuum seats, carpets, mats and trunk', true),
  ('interior', 1, 30, 'Clean all hard surfaces: dash, console, door panels, cup holders', true),
  ('interior', 1, 40, 'Steam clean and spot clean stains', true),
  ('interior', 1, 50, 'Clean door jambs', true),
  ('interior', 1, 60, 'Clean interior windows and mirrors', true),
  ('interior', 2, 70, 'Shampoo and extract carpets and floor mats', true),
  ('interior', 2, 80, 'Shampoo and extract seats', true),

  ('exterior', 1, 10, 'Pre-wash / foam the vehicle', true),
  ('exterior', 1, 20, 'Hand wash', true),
  ('exterior', 1, 30, 'Clean wheels and tires', true),
  ('exterior', 2, 35, 'Iron removal', true),
  ('exterior', 2, 36, 'Clay bar', true),
  ('exterior', 2, 37, 'Undercarriage cleaning', true),
  ('exterior', 2, 38, 'Engine bay cleaning', true),
  ('exterior', 1, 40, 'Dry the vehicle', true),
  ('exterior', 1, 50, 'Tire shine', true),
  ('exterior', 1, 60, 'Exterior plastic / trim shine', true),
  ('exterior', 1, 70, 'Apply wax (hand wax on Level 2)', true),
  ('exterior', 1, 80, 'Clean exterior glass', true),

  ('ceramic', 1, 10, 'Full decontamination wash (iron removal + clay)', true),
  ('ceramic', 1, 20, 'Inspect paint under a light; tell a manager about defects before coating', true),
  ('ceramic', 1, 30, 'Panel prep wipe on every panel to be coated', true),
  ('ceramic', 1, 40, 'Apply coating panel by panel and level all high spots', true),
  ('ceramic', 1, 50, 'Keep the vehicle dry for the cure time', true),
  ('ceramic', 1, 60, 'Give the customer the coating care instructions', true)
) as seed(scope, min_level, step_order, text, required)
where not exists (select 1 from public.service_checklists);
