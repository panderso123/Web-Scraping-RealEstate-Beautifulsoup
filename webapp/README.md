# Real Estate Listings — Web App (Cloudflare)

A dashboard over scraped realtor.com listings. **Cloudflare Worker** (API) +
**D1** (storage) + a static dashboard. Scraping runs separately and pushes data
in, because realtor.com blocks datacenter IPs.

**Live:** https://realestate-dashboard.panderso187.workers.dev

## Architecture

```
  Python scraper (your Mac / proxy)          Cloudflare
  ┌─────────────────────────────┐            ┌──────────────────────────────┐
  │ ingest_to_cloud.py          │  POST      │ Worker  src/index.ts         │
  │  reuses ScrapingToCsvFile   │ ─ /api/ ─► │  /api/ingest  (Bearer token) │
  │  requests OR browser engine │  ingest    │  /api/listings /api/stats    │
  └─────────────────────────────┘            │  static dashboard (public/)  │
                                             │            │                 │
                                             │            ▼   D1 (realestate)│
                                             └──────────────────────────────┘
```

The Worker never scrapes — it only stores and serves. Scraping happens where an
IP can actually reach realtor.com (your Mac, or through a US/residential proxy).

## One-time setup (already done for this deploy)

```bash
cd webapp
wrangler d1 create realestate                      # -> database_id in wrangler.jsonc
wrangler d1 execute realestate --remote --file=schema.sql
echo "$(openssl rand -hex 24)" | wrangler secret put INGEST_TOKEN   # pick/keep your own value
wrangler deploy
```

## Loading data

### ✅ Recommended: licensed API (RentCast) — `ingest_from_api.py`

realtor.com actively blocks scraping with a PerimeterX "Press & Hold" CAPTCHA
wall (confirmed on this network — both `requests` and a headless browser get a
bot page, not listings). Defeating that is off-limits, so the clean data source
is a **licensed API**. This app uses RentCast.

1. Get a free API key: https://app.rentcast.io/app/api (50 calls/month, no card).
2. Run the ingester:

```bash
# from the repo root
export RENTCAST_API_KEY="<your rentcast key>"
export WORKER_URL="https://realestate-dashboard.panderso187.workers.dev"
export INGEST_TOKEN="<same value as the Worker secret>"

python ingest_from_api.py --city Stockton --state CA --dry-run   # fetch & preview
python ingest_from_api.py --city Stockton --state CA             # fetch & push
python ingest_from_api.py --city Shelby   --state NC --limit 100
```

**💰 Cost:** free tier is **50 calls/month**. Each city refresh is ≥1 call —
one city refreshed twice daily (~60/mo) already exceeds free. Paid plans start at
**$74/mo** (1,000 req). Keep refreshes manual/occasional to stay free; only
enable a schedule if the dashboard is worth $74/mo to you.

### ⛔ Legacy: direct scraper — `ingest_to_cloud.py`

Kept for reference. Reuses `ScrapingToCsvFile.py` with `--engine requests|browser`
and optional `SCRAPER_PROXY`, but realtor.com's CAPTCHA wall makes it return 0
rows in practice. Not recommended.

Re-ingesting a city **updates** its rows (dedup on city + address), so either
ingester is safe to run repeatedly.

## Scheduled refresh (staged for you to install)

Because scraping must run from your Mac, schedule the ingester there with
launchd. Save as `~/Library/LaunchAgents/com.peter.realestate-ingest.plist`,
edit the paths/token/cities, then `launchctl load` it yourself:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.peter.realestate-ingest</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd /Users/peteranderson/Documents/GitHub/Web-Scraping-RealEstate-Beautifulsoup &amp;&amp; RENTCAST_API_KEY="REPLACE_ME" WORKER_URL="https://realestate-dashboard.panderso187.workers.dev" INGEST_TOKEN="REPLACE_ME" /Users/peteranderson/micromamba/bin/python ingest_from_api.py --city Stockton --state CA</string>
  </array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>19</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/tmp/realestate-ingest.log</string>
  <key>StandardErrorPath</key><string>/tmp/realestate-ingest.err</string>
</dict></plist>
```
```bash
launchctl load ~/Library/LaunchAgents/com.peter.realestate-ingest.plist
```

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/listings` | filters: `city, q, min_price, max_price, beds, type, absentee=1, corporate=1, min_discount, min_yield, enriched=1`; `sort(price\|scraped\|ppsf\|dom\|discount\|yield\|value)`, `dir`, `limit` |
| GET | `/api/stats` | totals, enriched count, per-city/type counts, price + yield averages, budget |
| GET | `/api/budget` | RentCast calls used this month vs `RENTCAST_MONTHLY_CAP` (default 50 = free tier) |
| GET | `/api/export.csv` | lead-list CSV of the current filter set (same params as /api/listings) |
| POST | `/api/ingest` | Bearer `INGEST_TOKEN`; body `{city, rows:[…]}` |
| POST | `/api/refresh` | Bearer; pull sale listings from RentCast (`?city=&state=` or CITIES var); 1 call/city |
| POST | `/api/enrich` | Bearer; body `{id}` — owner record + AVM value/comps + rent estimate for one listing = **3 RentCast calls**; results cached in D1 forever |

## PropStream-style layer

Enrichment computes per property: **absentee owner** (mailing ≠ property address),
**corporate owner**, **discount-to-value %** (list vs AVM), **gross rent yield %**,
plus sale history, year built, and top value comps. Deal chips in the UI filter on
these; Export CSV produces a lead list. A hard budget cap (`RENTCAST_MONTHLY_CAP`
var) makes RentCast-spending routes refuse with 429 rather than silently exceed
the free tier. Not included (data RentCast doesn't have): pre-foreclosures,
liens, skip tracing.

## Design

The dashboard wears the **Anderson House Style** — `public/assets/anderson.css`
is a VERBATIM vendored copy of the source of truth at
`~/business/active/creator-lab-vault/public/assets/anderson.css` (the hosted
vault copy 403'd intermittently, so assets are served same-origin). To update
the style, re-copy the file; do not edit the vendored copy.

## Local dev

```bash
cd webapp
wrangler dev            # uses a local D1; seed with: wrangler d1 execute realestate --local --file=schema.sql
```
