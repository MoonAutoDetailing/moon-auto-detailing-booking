-- Managers and the owner may clock in away from home base without a PIN.
-- Those entries are recorded as verify_method 'anywhere' (location still saved when available).
alter table public.time_entries drop constraint if exists time_entries_verify_method_check;
alter table public.time_entries
  add constraint time_entries_verify_method_check
  check (verify_method in ('gps', 'pin', 'manager', 'anywhere'));
