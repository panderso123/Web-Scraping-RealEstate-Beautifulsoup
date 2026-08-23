-- Enrich listings with fields RentCast provides + derived metrics.
ALTER TABLE listings ADD COLUMN property_type  TEXT;
ALTER TABLE listings ADD COLUMN days_on_market INTEGER;
ALTER TABLE listings ADD COLUMN listed_date    TEXT;
ALTER TABLE listings ADD COLUMN sqft_num       INTEGER;   -- numeric sqft parsed from sqft text
ALTER TABLE listings ADD COLUMN price_per_sqft INTEGER;   -- price_num / sqft_num, computed at ingest

CREATE INDEX IF NOT EXISTS idx_listings_type ON listings(property_type);
CREATE INDEX IF NOT EXISTS idx_listings_ppsf ON listings(price_per_sqft);
