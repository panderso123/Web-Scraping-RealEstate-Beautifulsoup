-- Off-market lead layer: county assessor records (public ArcGIS REST APIs).
-- High-value absentee owners = the "luxury list that's not on market".

CREATE TABLE IF NOT EXISTS offmarket (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  county         TEXT NOT NULL,           -- Denver / Jefferson / ...
  situs_address  TEXT NOT NULL,           -- property street address
  situs_city     TEXT,
  situs_zip      TEXT,
  owner_name     TEXT,
  owner_mailing  TEXT,                    -- full mailing address line
  owner_city     TEXT,
  owner_state    TEXT,                    -- out-of-state = absentee signal
  owner_zip      TEXT,
  actual_value   INTEGER,                 -- county appraised/actual total value
  last_sale_date TEXT,                    -- ISO yyyy-mm-dd when parseable
  last_sale_price INTEGER,
  year_built     INTEGER,
  prop_class     TEXT,
  fetched_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(county, situs_address, situs_city)
);

CREATE INDEX IF NOT EXISTS idx_offmarket_value ON offmarket(actual_value);
CREATE INDEX IF NOT EXISTS idx_offmarket_state ON offmarket(owner_state);
CREATE INDEX IF NOT EXISTS idx_offmarket_county ON offmarket(county);
