-- Add optional customer notes to bookings (trimmed, null when empty)
alter table public.bookings
add column if not exists customer_notes text;

comment on column public.bookings.customer_notes is 'Optional customer-provided notes (e.g. special requests); not included in emails.';
