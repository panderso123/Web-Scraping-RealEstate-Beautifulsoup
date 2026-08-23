-- Realtor listings dashboard schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS listings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  city       TEXT NOT NULL,
  location   TEXT NOT NULL,
  status     TEXT,
  price_text TEXT,
  price_num  INTEGER,          -- numeric price parsed from price_text, NULL if unknown
  owner      TEXT,
  bed        TEXT,
  bath       TEXT,
  sqft       TEXT,
  sqft_lot   TEXT,
  scraped_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(city, location)       -- re-ingesting a city updates existing rows instead of duplicating
);

CREATE INDEX IF NOT EXISTS idx_listings_city  ON listings(city);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price_num);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
