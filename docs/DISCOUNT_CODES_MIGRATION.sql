-- Discount codes: run this migration before using the discount code feature.
-- Table: discount_codes
-- Booking snapshot columns: discount_code, discount_percent, discount_amount on bookings

-- 1) Create discount_codes table
CREATE TABLE IF NOT EXISTS discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  code_normalized TEXT NOT NULL UNIQUE,
  percent_off NUMERIC(5,2) NOT NULL CHECK (percent_off > 0 AND percent_off <= 100),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  is_disabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discount_codes_starts_before_ends CHECK (starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS idx_discount_codes_code_normalized ON discount_codes (code_normalized);
CREATE INDEX IF NOT EXISTS idx_discount_codes_starts_ends ON discount_codes (starts_at, ends_at);

-- 2) Add discount snapshot columns to bookings (if not already present)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_code TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2);

-- Optional: trigger to keep updated_at on discount_codes (if your DB supports it)
-- CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
-- BEGIN
--   NEW.updated_at = now();
--   RETURN NEW;
-- END; $$ LANGUAGE plpgsql;
-- DROP TRIGGER IF EXISTS discount_codes_updated_at ON discount_codes;
-- CREATE TRIGGER discount_codes_updated_at BEFORE UPDATE ON discount_codes
--   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
