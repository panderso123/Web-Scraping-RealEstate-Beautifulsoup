#!/usr/bin/env python3
"""
Pre-foreclosure ingester: download county Public Trustee weekly NED
(Notice of Election & Demand) PDFs, parse them, and push to the dashboard.

Free public records. Requires pdfplumber:
    uv pip install pdfplumber   (or pip install pdfplumber)

Usage:
    export WORKER_URL="https://realestate.creativeconquests.online"
    export INGEST_TOKEN="<same value as the Worker secret>"

    python ingest_foreclosures.py --county Jefferson --url "https://gts.co.jefferson.co.us/Report_Files/NED%208-20-2026.pdf"
    python ingest_foreclosures.py --county Jefferson --pdf ./local_ned.pdf --dry-run

The Jefferson parser handles the GTS trustee-software NED layout. Arapahoe and
Adams use the same GTS software (near-identical layout) so --county Arapahoe /
Adams reuse the same parser; verify the first run with --dry-run.
"""
import argparse, json, os, re, sys, tempfile, urllib.request

MONEY = re.compile(r'\$[\d,]+\.\d{2}')
ADDR = re.compile(r'([^\n]*,\s*[A-Za-z .]+,\s*[A-Z]{2}\s*\d{5}[^\n]*)')
DATE = re.compile(r'\b(\d{2}/\d{2}/\d{4})\b')


def _iso(mdy):
    if not mdy:
        return None
    m = re.match(r'(\d{2})/(\d{2})/(\d{4})', mdy)
    return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else None


def parse_ned(pdf_path):
    import pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        full = "\n".join((p.extract_text() or "") for p in pdf.pages)

    recs = []
    for b in re.split(r'(?=Foreclosure Number:)', full):
        m_num = re.search(r'Foreclosure Number:\s*(\S+)(?:\s+(\w+))?', b)
        if not m_num:
            continue
        m_owner = re.search(r'Current Owner:\s*(.+)', b)
        m_addr = ADDR.search("\n" + b)
        addr = m_addr.group(1).strip() if m_addr else None
        if addr:
            addr = re.sub(r'^Address:\s*', '', addr).strip()
        dollars = MONEY.findall(b)
        m_ned = re.search(r'NED Date:\s*(?:\n[^\n]*)*?(\d{2}/\d{2}/\d{4})', b)
        return_ned = _iso(m_ned.group(1)) if m_ned else (_iso(DATE.search(b).group(1)) if DATE.search(b) else None)
        recs.append({
            "fc_number": m_num.group(1),
            "status": (m_num.group(2) or None),
            "owner_name": (m_owner.group(1).strip() if m_owner else None),
            "property_address": addr,
            "current_amount": dollars[0] if dollars else None,
            "original_note": dollars[1] if len(dollars) > 1 else None,
            "ned_date": return_ned,
        })
    return recs


def push(worker_url, token, county, source_pdf, records):
    payload = json.dumps({"county": county, "source_pdf": source_pdf, "records": records}).encode()
    req = urllib.request.Request(
        worker_url.rstrip("/") + "/api/foreclosure/ingest", data=payload, method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {token}",
                 "user-agent": "foreclosure-ingester/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def main():
    ap = argparse.ArgumentParser(description="Ingest county NED foreclosure PDFs")
    ap.add_argument("--county", required=True, help="Jefferson | Arapahoe | Adams")
    ap.add_argument("--url", help="NED PDF URL to download")
    ap.add_argument("--pdf", help="local NED PDF path (instead of --url)")
    ap.add_argument("--worker", default=os.environ.get("WORKER_URL", ""))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.url and not args.pdf:
        sys.exit("Provide --url or --pdf")

    if args.pdf:
        pdf_path, source = args.pdf, args.pdf
    else:
        source = args.url
        fd, pdf_path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        req = urllib.request.Request(args.url, headers={"user-agent": "foreclosure-ingester/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r, open(pdf_path, "wb") as f:
            f.write(r.read())

    records = parse_ned(pdf_path)
    print(f"Parsed {len(records)} NED record(s) for {args.county}.")
    ok = sum(1 for r in records if r["property_address"] and r["owner_name"])
    print(f"  with address+owner: {ok}/{len(records)}")
    if not records:
        sys.exit("No records parsed — the county's PDF layout may differ; inspect with --dry-run.")

    if args.dry_run:
        print(json.dumps(records[:5], indent=2))
        return

    token = os.environ.get("INGEST_TOKEN", "")
    if not args.worker or not token:
        sys.exit("Set WORKER_URL and INGEST_TOKEN to push (or use --dry-run).")
    print("Push result:", json.dumps(push(args.worker, token, args.county, source, records)))


if __name__ == "__main__":
    main()
