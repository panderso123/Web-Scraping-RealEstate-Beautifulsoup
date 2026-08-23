#!/usr/bin/env python3
"""
Scrape realtor.com listings for a city and push them to the Cloudflare Worker.

This reuses the scraping/parsing already in ScrapingToCsvFile.py, so there is one
source of truth for how a listing is parsed. It runs where scraping actually
works (your Mac, or through a US/residential proxy) and POSTs the rows to the
Worker's /api/ingest endpoint. The Worker + D1 then serve the dashboard.

Usage:
    export WORKER_URL="https://realestate-dashboard.<your-subdomain>.workers.dev"
    export INGEST_TOKEN="<the token you set as a Worker secret>"
    # optional, for US-geofenced scraping from a blocked network:
    export SCRAPER_PROXY="http://user:pass@host:port"

    python ingest_to_cloud.py --city Stockton_CA
    python ingest_to_cloud.py --city Shelby_NC --engine browser   # if requests is blocked

Schedule it (e.g. every 6h) with launchd/cron on the machine that can reach
realtor.com. See webapp/README.md for a launchd template.
"""
import argparse
import os
import sys
import json
import urllib.request

from bs4 import BeautifulSoup

import ScrapingToCsvFile as scraper

FIELDS = ["location", "status", "price", "owner", "bed", "bath", "sqft", "sqft_lot"]


def scrape_city(city: str, engine: str, timeout: float):
    """Return a list of dict rows using the existing scraper's logic."""
    target_url = scraper.build_url(city)

    # Honor a proxy for requests-based scraping (US-geofenced sites).
    proxy = os.environ.get("SCRAPER_PROXY") or os.environ.get("HTTPS_PROXY")
    if engine == "requests" and proxy:
        scraper.requests_proxies = {"http": proxy, "https": proxy}
        # ScrapingToCsvFile uses requests.get directly; patch its session call.
        orig_get = scraper.requests.get
        scraper.requests.get = lambda url, **kw: orig_get(url, proxies={"http": proxy, "https": proxy}, **kw)  # type: ignore

    if engine == "browser":
        html, collected = scraper.fetch_html("browser", target_url, timeout)
    else:
        html = scraper.fetch_html("requests", target_url, timeout)
        collected = []

    soup = BeautifulSoup(html, "html.parser")
    cards = scraper.find_listings(soup)
    tuples = [scraper.parse_card(c) for c in cards] if cards else []
    if not tuples:
        tuples = scraper.extract_from_json_ld(soup)
    if not tuples and collected:
        tuples = scraper.extract_from_collected_json(collected)

    return [dict(zip(FIELDS, t)) for t in tuples]


def push(worker_url: str, token: str, city: str, rows: list) -> dict:
    payload = json.dumps({"city": city, "rows": rows}).encode("utf-8")
    req = urllib.request.Request(
        worker_url.rstrip("/") + "/api/ingest",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
            # Cloudflare's edge 403s the default urllib UA on workers.dev.
            "user-agent": "realestate-ingester/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser(description="Scrape a city and push to the Cloudflare dashboard")
    ap.add_argument("--city", default="Stockton_CA", help="City slug, e.g. Stockton_CA")
    ap.add_argument("--engine", choices=["requests", "browser"], default="requests")
    ap.add_argument("--timeout", type=float, default=25.0)
    ap.add_argument("--url", default=os.environ.get("WORKER_URL", ""), help="Worker base URL (or set WORKER_URL)")
    ap.add_argument("--dry-run", action="store_true", help="Scrape and print rows, do not push")
    args = ap.parse_args()

    token = os.environ.get("INGEST_TOKEN", "")
    if not args.dry_run and (not args.url or not token):
        sys.exit("Set WORKER_URL and INGEST_TOKEN (env or --url). Use --dry-run to test scraping only.")

    rows = scrape_city(args.city, args.engine, args.timeout)
    print(f"Scraped {len(rows)} listing(s) for {args.city} via {args.engine}.")
    if not rows:
        sys.exit("No rows scraped — realtor.com likely blocked this IP. Try --engine browser or set SCRAPER_PROXY.")

    if args.dry_run:
        print(json.dumps(rows[:5], indent=2))
        print(f"... ({len(rows)} total). Dry run — nothing pushed.")
        return

    result = push(args.url, token, args.city, rows)
    print("Ingest result:", json.dumps(result))


if __name__ == "__main__":
    main()
