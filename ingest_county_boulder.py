#!/usr/bin/env python3
"""
Boulder County off-market lead ingester.

Boulder has no ArcGIS layer carrying owner mailing addresses, so we use its
nightly public assessor CSVs (assessor.boco.solutions), join them, filter to
high-value absentee owners, and push to the dashboard's /api/offmarket/ingest.
Free public records.

Usage:
    export WORKER_URL="https://realestate.creativeconquests.online"
    export INGEST_TOKEN="<same value as the Worker secret>"
    python ingest_county_boulder.py                 # download, join, push
    python ingest_county_boulder.py --dry-run       # download, join, print sample
"""
import argparse, csv, io, json, os, sys, urllib.request

BASE = "https://assessor.boco.solutions/ASR_PublicDataFiles"
MIN_VALUE = 800_000
UA = {"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) county-ingester/1.0"}


def fetch_csv(name):
    req = urllib.request.Request(f"{BASE}/{name}", headers=UA)
    with urllib.request.urlopen(req, timeout=180) as r:
        data = r.read().decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(data)))


def build_rows():
    print("Downloading Values.csv …")
    values = fetch_csv("Values.csv")
    # current tax year row per strap
    val = {}
    for v in values:
        try:
            tv = float(v.get("totalActualVal") or 0)
        except ValueError:
            tv = 0
        yr = v.get("tax_yr") or "0"
        strap = v.get("strap")
        if not strap:
            continue
        if strap not in val or yr > val[strap][1]:
            val[strap] = (tv, yr)

    print(f"  {len(val):,} straps with a value; downloading Owner_Address.csv …")
    owners = fetch_csv("Owner_Address.csv")

    seen = set()
    rows = []
    for o in owners:
        strap = o.get("strap")
        if not strap or strap in seen:
            continue
        # prefer primary owner role
        if o.get("role_cd") not in (None, "", "P") and strap in seen:
            continue
        v = val.get(strap)
        if not v or v[0] < MIN_VALUE:
            continue
        state = (o.get("mailingState") or "").strip().upper()
        if not state or state == "CO":
            continue
        seen.add(strap)
        situs = " ".join(str(o.get(k) or "").strip() for k in
                         ("str_num", "str_pfx", "str", "str_sfx", "str_unit")).strip()
        rows.append({
            "situs_address": situs or None,
            "situs_city": (o.get("city") or None),
            "situs_zip": None,
            "owner_name": (o.get("owner_name") or None),
            "owner_mailing": (o.get("mailingAddr1") or None),
            "owner_city": (o.get("mailingCity") or None),
            "owner_state": state,
            "owner_zip": (o.get("mailingZip") or None),
            "actual_value": int(v[0]),
            "last_sale_date": None,
            "last_sale_price": None,
            "year_built": None,
            "prop_class": (o.get("account_type") or None),
        })
    rows = [r for r in rows if r["situs_address"]]
    return rows


def push(worker_url, token, rows):
    total = 0
    for i in range(0, len(rows), 400):
        chunk = rows[i:i + 400]
        payload = json.dumps({"county": "Boulder", "rows": chunk}).encode()
        req = urllib.request.Request(
            worker_url.rstrip("/") + "/api/offmarket/ingest", data=payload, method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {token}",
                     "user-agent": "county-ingester/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            total += json.loads(r.read().decode())["ingested"]
        print(f"  pushed {total}/{len(rows)}")
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", default=os.environ.get("WORKER_URL", ""))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = build_rows()
    print(f"Boulder high-value absentee leads: {len(rows):,}")
    if not rows:
        sys.exit("No rows — check CSV availability / field names.")
    if args.dry_run:
        print(json.dumps(rows[:5], indent=2))
        return
    token = os.environ.get("INGEST_TOKEN", "")
    if not args.worker or not token:
        sys.exit("Set WORKER_URL and INGEST_TOKEN to push (or use --dry-run).")
    print("Pushed:", push(args.worker, token, rows))


if __name__ == "__main__":
    main()
