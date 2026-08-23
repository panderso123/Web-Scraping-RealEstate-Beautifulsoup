-- PropStream-style enrichment: owner records, AVM valuation, rent estimate,
-- computed deal metrics, and an API-usage budget counter.

ALTER TABLE listings ADD COLUMN owner_names     TEXT;     -- JSON array
ALTER TABLE listings ADD COLUMN owner_type      TEXT;     -- Individual / Organization / ...
ALTER TABLE listings ADD COLUMN owner_mailing   TEXT;     -- formatted mailing address
ALTER TABLE listings ADD COLUMN absentee        INTEGER;  -- 1 = owner mailing addr != property addr
ALTER TABLE listings ADD COLUMN corporate_owner INTEGER;  -- 1 = owner not an individual
ALTER TABLE listings ADD COLUMN last_sale_date  TEXT;
ALTER TABLE listings ADD COLUMN last_sale_price INTEGER;
ALTER TABLE listings ADD COLUMN year_built      INTEGER;
ALTER TABLE listings ADD COLUMN avm_value       INTEGER;  -- RentCast /avm/value price
ALTER TABLE listings ADD COLUMN avm_low         INTEGER;
ALTER TABLE listings ADD COLUMN avm_high        INTEGER;
ALTER TABLE listings ADD COLUMN rent_est        INTEGER;  -- RentCast /avm/rent/long-term rent
ALTER TABLE listings ADD COLUMN rent_low        INTEGER;
ALTER TABLE listings ADD COLUMN rent_high       INTEGER;
ALTER TABLE listings ADD COLUMN discount_pct    REAL;     -- (avm_value - price_num) / avm_value * 100
ALTER TABLE listings ADD COLUMN gross_yield_pct REAL;     -- rent_est * 12 / price_num * 100
ALTER TABLE listings ADD COLUMN comps_json      TEXT;     -- top value comps, JSON
ALTER TABLE listings ADD COLUMN enriched_at     TEXT;

CREATE INDEX IF NOT EXISTS idx_listings_discount ON listings(discount_pct);
CREATE INDEX IF NOT EXISTS idx_listings_yield    ON listings(gross_yield_pct);
CREATE INDEX IF NOT EXISTS idx_listings_absentee ON listings(absentee);

-- RentCast call budget, per calendar month ("YYYY-MM" keys).
CREATE TABLE IF NOT EXISTS api_usage (
  month TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);
