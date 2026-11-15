-- Who on the team booked it (crew-app bookings by employees). Null for customer and admin bookings.
alter table public.bookings add column if not exists booked_by uuid references public.staff (id) on delete set null;
