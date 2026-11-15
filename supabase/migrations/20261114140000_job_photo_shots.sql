-- Guided before/after photos: which angle a photo is (front_driver, trunk, ext_front, ...).
-- Null for damage photos and for photos taken before guided shots existed.
alter table public.job_photos add column if not exists shot text;
alter table public.job_photos drop constraint if exists job_photos_shot_check;
alter table public.job_photos add constraint job_photos_shot_check check (shot is null or shot ~ '^[a-z_]{2,40}$');
create index if not exists idx_job_photos_shot on public.job_photos (booking_id, kind, shot);
