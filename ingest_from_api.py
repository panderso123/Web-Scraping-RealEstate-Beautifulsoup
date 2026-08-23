#!/usr/bin/env python3
"""
Load listings from the RentCast licensed API and push them to the dashboard.

This is the ToS-clean data source: RentCast is a licensed property-data provider
with a documented API, so no scraping / CAPTCHA-dodging is involved.

    Docs:    https://developers.rentcast.io/reference/sale-listings
    Pricing: 50 calls/month free (no card), then $74/mo (Foundation) and up.
             NOTE: each city refresh is >=1 call. One city refreshed twice a day
             (~60/mo) already exceeds the free tier — budget accordingly.

Usage:
    export RENTCAST_API_KEY="<your rentcast key>"
    export WORKER_URL="https://realestate-dashboard.panderso187.workers.dev"
    export INGEST_TOKEN="<same value as the Worker secret>"

    python ingest_from_api.py --city Stockton --state CA
    python ingest_from_api.py --city Shelby --state NC --limit 100
    python ingest_from_api.py --city Stockton --state CA --dry-run   # no push

Accepts a "Stockton_CA" style slug too:  --city Stockton_CA
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

from ingest_to_cloud import push  # reuse the same authenticated push

API_BASE = "https://api.rentcast.io/v1/listings/sale"


def _maybe(v):
    return None if v is None else str(v)


def fetch_listings(api_key: str, city: str, state: str, limit: int):
    """Call RentCast and return a list of dict rows in the dashboard's schema."""
    params = {"city": city, "state": state, "status": "Active", "limit": max(1, min(limit, 500))}
    url = API_BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"X-Api-Key": api_key, "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    # RentCast returns a JSON array of listing objects.
    items = data if isinstance(data, list) else data.get("listings", data.get("data", []))
    rows = []
    for it in items:
        if not isinstance(it, dict):
            continue
        agent = it.get("listingAgent") or {}
        office = it.get("listingOffice") or {}
        owner = agent.get("name") or office.get("name") or "Not specified"
        rows.append({
            "location": it.get("formattedAddress") or "Not specified",
            "status": it.get("status") or it.get("listingType") or "Not specified",
            "price": _maybe(it.get("price")) or "Not specified",
            "owner": owner,
            "bed": _maybe(it.get("bedrooms")) or "NoV",
            "bath": _maybe(it.get("bathrooms")) or "NoV",
            "sqft": _maybe(it.get("squareFootage")) or "NoV",
            "sqft_lot": _maybe(it.get("lotSize")) or "NoV",
        })
    return rows


def main():
    ap = argparse.ArgumentParser(description="Load RentCast listings into the dashboard")
    ap.add_argument("--city", required=True, help="City name, e.g. Stockton (or a Stockton_CA slug)")
    ap.add_argument("--state", help="2-letter state, e.g. CA (optional if using a slug)")
    ap.add_argument("--limit", type=int, default=100, help="Max listings to fetch (1-500)")
    ap.add_argument("--url", default=os.environ.get("WORKER_URL", ""), help="Worker base URL (or WORKER_URL env)")
    ap.add_argument("--dry-run", action="store_true", help="Fetch and print, do not push")
    args = ap.parse_args()

    city, state = args.city, args.state
    if not state and "_" in city:              # accept "Stockton_CA" slug
        city, state = city.rsplit("_", 1)
    if not state:
        sys.exit("Provide --state (2-letter) or a slug like Stockton_CA")

    api_key = os.environ.get("RENTCAST_API_KEY", "")
    if not api_key:
        sys.exit("Set RENTCAST_API_KEY (get a free key at https://app.rentcast.io/app/api)")

    token = os.environ.get("INGEST_TOKEN", "")
    if not args.dry_run and (not args.url or not token):
        sys.exit("Set WORKER_URL and INGEST_TOKEN to push (or use --dry-run).")

    rows = fetch_listings(api_key, city, state, args.limit)
    # Store under the same "City_ST" slug the dashboard groups by.
    city_slug = f"{city}_{state}"
    print(f"Fetched {len(rows)} listing(s) for {city_slug} from RentCast.")
    if not rows:
        sys.exit("No listings returned — check the city/state spelling and your API quota.")

    if args.dry_run:
        print(json.dumps(rows[:5], indent=2))
        print(f"... ({len(rows)} total). Dry run — nothing pushed.")
        return

    result = push(args.url, token, city_slug, rows)
    print("Ingest result:", json.dumps(result))


if __name__ == "__main__":
    main()
