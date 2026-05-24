-- CRM outbound message log (one-to-one admin sends; not booking lifecycle emails).
-- Mass/bulk email campaigns require unsubscribe support before use.

create table if not exists public.crm_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  booking_id uuid references public.bookings(id) on delete set null,
  channel text not null default 'email',
  provider text default 'resend',
  provider_message_id text,
  direction text default 'outbound',
  template_key text,
  subject text,
  body text not null,
  recipient_email text,
  recipient_phone text,
  status text default 'sent',
  error_message text,
  sent_by text default 'admin',
  sent_at timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists crm_outbound_messages_customer_id_idx
  on public.crm_outbound_messages (customer_id);

create index if not exists crm_outbound_messages_channel_idx
  on public.crm_outbound_messages (channel);

create index if not exists crm_outbound_messages_status_idx
  on public.crm_outbound_messages (status);

create index if not exists crm_outbound_messages_sent_at_idx
  on public.crm_outbound_messages (sent_at);
