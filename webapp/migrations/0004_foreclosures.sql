-- Pre-foreclosure layer: parsed from county Public Trustee weekly NED
-- (Notice of Election & Demand) PDFs. The distress signal PropStream charges for.

CREATE TABLE IF NOT EXISTS foreclosures (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  county           TEXT NOT NULL,
  fc_number        TEXT NOT NULL,          -- county foreclosure case number
  status           TEXT,                   -- e.g. "Restarted", or NULL for new
  owner_name       TEXT,
  property_address TEXT,
  current_amount   INTEGER,                -- current amount owed
  original_note    INTEGER,                -- original note amount
  ned_date         TEXT,                   -- ISO yyyy-mm-dd
  first_pub_date   TEXT,
  sale_date        TEXT,
  source_pdf       TEXT,
  fetched_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(county, fc_number)
);

CREATE INDEX IF NOT EXISTS idx_fc_county ON foreclosures(county);
CREATE INDEX IF NOT EXISTS idx_fc_ned ON foreclosures(ned_date);
