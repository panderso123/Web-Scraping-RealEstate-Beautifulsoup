-- Cross-reference layer: attach a RentCast rent estimate to an off-market
-- county lead and compute gross yield against the county actual value.

ALTER TABLE offmarket ADD COLUMN rent_est        INTEGER;
ALTER TABLE offmarket ADD COLUMN gross_yield_pct REAL;   -- rent_est*12 / actual_value * 100
ALTER TABLE offmarket ADD COLUMN rent_enriched_at TEXT;

CREATE INDEX IF NOT EXISTS idx_offmarket_yield ON offmarket(gross_yield_pct);
