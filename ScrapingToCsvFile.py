from bs4 import BeautifulSoup
import requests
from csv import writer
import argparse
import os
import json
from typing import List, Tuple

# Keep these for backwards-compatibility with the existing test file
url = "https://www.realtor.com/realestateandhomes-search/Stockton_CA/show-newest-listings"
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Accept-Encoding": "gzip, deflate",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "DNT": "1",
    "Connection": "close",
    "Upgrade-Insecure-Requests": "1",
}

HEADER_ROW = ['Location', 'Status', 'Price', 'Owner', 'Bed', 'Bath', 'SQFT', 'SQFT_LOT']


def build_url(city_slug: str) -> str:
    return f"https://www.realtor.com/realestateandhomes-search/{city_slug}/show-newest-listings"


def extract_text(node):
    return node.get_text(strip=True) if node else 'Not specified'


def find_listings(soup: BeautifulSoup) -> List:
    # Try multiple strategies to find listing cards
    strategies = [
        lambda s: s.select('[data-testid="property-card"]'),
        lambda s: s.select('[data-testid="search-result-element"]'),
        lambda s: s.find_all('li', attrs={'data-testid': 'result-card'}),
        lambda s: s.find_all('div', class_="jsx-2775064451 fallBackImgWrap"),
    ]
    for strat in strategies:
        cards = strat(soup)
        if cards:
            return cards
    return []


def parse_card(card) -> Tuple[str, str, str, str, str, str, str, str]:
    # Try stable data-testid attributes first
    location = (card.select_one('[data-testid="property-address"]') or
                card.select_one('[data-testid="srp-home-card-address"]'))
    status = (card.select_one('[data-testid="srp-home-card-status"]') or
              card.select_one('[data-testid="property-status"]'))
    price = (card.select_one('[data-testid="property-price"]') or
             card.select_one('[data-label="pc-price"]'))
    owner = card.select_one('[data-testid="seller-name"]')

    # Meta values
    bed = (card.select_one('[data-testid="property-meta-beds"]') or
           card.select_one('[data-testid="srp-home-card-beds"]'))
    bath = (card.select_one('[data-testid="property-meta-baths"]') or
            card.select_one('[data-testid="srp-home-card-baths"]'))
    sqft = (card.select_one('[data-testid="property-meta-sqft"]') or
            card.select_one('[data-testid="srp-home-card-sqft"]'))
    lot = (card.select_one('[data-testid="property-meta-lot-size"]') or
           card.select_one('[data-label="pc-lot-size"]'))

    # Fallbacks to legacy classes if needed
    if not location:
        location = card.find('div', class_="jsx-1982357781 address ellipsis srp-page-address srp-address-redesign")
    if not price:
        price = card.find('span', class_="Price__Component-rui__x3geed-0 gipzbd")
    if not status:
        status = card.find('span', class_="jsx-3853574337 statusText")
    if not owner:
        ow = card.find_all('span', class_="jsx-287440024")
        owner = ow[1] if ow and len(ow) > 1 else None
    if not (bed and bath and sqft and lot):
        infos = card.find_all('span', class_="jsx-946479843 meta-value")
        vals = [i.get_text(strip=True) for i in infos] if infos else []
        # Pad to 4 with 'NoV'
        while len(vals) < 4:
            vals.append('NoV')
        bed_f, bath_f, sqft_f, lot_f = (vals + ['NoV', 'NoV', 'NoV', 'NoV'])[:4]
    else:
        bed_f = extract_text(bed)
        bath_f = extract_text(bath)
        sqft_f = extract_text(sqft)
        lot_f = extract_text(lot)

    return (
        extract_text(location),
        extract_text(status),
        extract_text(price),
        extract_text(owner),
        bed_f, bath_f, sqft_f, lot_f,
    )


def write_csv(rows: List[Tuple[str, ...]], out_path: str):
    os.makedirs(os.path.dirname(out_path), exist_ok=True) if os.path.dirname(out_path) else None
    with open(out_path, 'w', encoding='utf8', newline='') as f:
        w = writer(f)
        w.writerow(HEADER_ROW)
        for r in rows:
            w.writerow(list(r))


def extract_from_json_ld(soup: BeautifulSoup) -> List[Tuple[str, str, str, str, str, str, str, str]]:
    rows = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            data = json.loads(script.string or "{}")
        except Exception:
            continue
        items = []
        if isinstance(data, list):
            items = data
        elif isinstance(data, dict):
            if '@graph' in data and isinstance(data['@graph'], list):
                items = data['@graph']
            else:
                items = [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            # Heuristic: look for an Offer/Place/Residence-like object
            price = item.get('offers', {}).get('price') if isinstance(item.get('offers'), dict) else item.get('price')
            address = item.get('address', {})
            if isinstance(address, dict):
                addr_text = ", ".join(
                    [address.get('streetAddress', ''), address.get('addressLocality', ''), address.get('addressRegion', ''), address.get('postalCode', '')]
                ).strip(', ').replace(' ,', ',')
            else:
                addr_text = str(address) if address else None
            if addr_text or price:
                rows.append((
                    addr_text or 'Not specified',
                    item.get('availability') or item.get('propertyStatus') or 'Not specified',
                    str(price) if price else 'Not specified',
                    item.get('seller', {}).get('name') if isinstance(item.get('seller'), dict) else 'Not specified',
                    str(item.get('numberOfRooms') or 'NoV'),
                    'NoV',
                    str(item.get('floorSize', {}).get('value')) if isinstance(item.get('floorSize'), dict) else 'NoV',
                    'NoV',
                ))
    return rows


def _maybe_str(v):
    return None if v is None else str(v)


def extract_from_collected_json(collected: List[dict]) -> List[Tuple[str, str, str, str, str, str, str, str]]:
    rows: List[Tuple[str, str, str, str, str, str, str, str]] = []
    def add_row(addr, status, price, owner, bed, bath, sqft, lot):
        rows.append((addr or 'Not specified', status or 'Not specified', _maybe_str(price) or 'Not specified', owner or 'Not specified', _maybe_str(bed) or 'NoV', _maybe_str(bath) or 'NoV', _maybe_str(sqft) or 'NoV', _maybe_str(lot) or 'NoV'))

    for item in collected:
        data = item.get('json')
        if not isinstance(data, dict):
            continue
        # Try common shapes
        candidates = []
        try_paths = [
            ['data', 'home_search', 'results'],
            ['home_search', 'results'],
            ['data', 'homeSearch', 'homes'],
            ['properties'],
            ['data', 'homes'],
        ]
        for path in try_paths:
            cur = data
            ok = True
            for key in path:
                if isinstance(cur, dict) and key in cur:
                    cur = cur[key]
                else:
                    ok = False
                    break
            if ok and isinstance(cur, list):
                candidates = cur
                break
        if not candidates and isinstance(data.get('data'), list):
            candidates = data['data']
        for h in candidates:
            if not isinstance(h, dict):
                continue
            # Try various field names
            addr_parts = []
            addr_obj = h.get('location') or h.get('address') or {}
            if isinstance(addr_obj, dict):
                for k in ['address', 'line', 'street', 'streetAddress']:
                    if addr_obj.get(k):
                        addr_parts.append(str(addr_obj.get(k)))
                        break
                city = addr_obj.get('city') or addr_obj.get('locality')
                region = addr_obj.get('state') or addr_obj.get('region')
                postal = addr_obj.get('postal_code') or addr_obj.get('postalCode')
                for v in [city, region, postal]:
                    if v:
                        addr_parts.append(str(v))
            addr = ", ".join([p for p in addr_parts if p]) if addr_parts else None

            price = h.get('price') or (h.get('list_price') if isinstance(h.get('list_price'), (int, float, str)) else None)
            status = h.get('status') or h.get('prop_status')
            owner = (h.get('seller', {}) or {}).get('name') if isinstance(h.get('seller'), dict) else None
            bed = h.get('beds') or h.get('bed')
            bath = h.get('baths') or h.get('bath')
            sqft = h.get('sqft') or h.get('building_size', {}).get('size') if isinstance(h.get('building_size'), dict) else h.get('livingArea')
            lot = h.get('lot_size') or (h.get('lot_size_raw') if isinstance(h.get('lot_size_raw'), (int, float, str)) else None)

            add_row(addr, status, price, owner, bed, bath, sqft, lot)

    return rows


def fetch_html(engine: str, target_url: str, timeout: float, headless: bool = True, max_scrolls: int = 5):
    """
    Returns a tuple of (html, collected_json) when engine='browser', otherwise html string.
    collected_json is a list of dicts from JSON XHR responses captured during page load.
    """
    if engine == 'requests':
        resp = requests.get(target_url, headers=headers, timeout=timeout)
        return resp.text
    elif engine == 'browser':
        try:
            from playwright.sync_api import sync_playwright
        except Exception as e:
            raise RuntimeError(
                "Playwright is not installed. Run: pip install playwright && playwright install chromium"
            ) from e
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless, args=["--disable-blink-features=AutomationControlled"]) 
            context = browser.new_context(user_agent=headers.get("User-Agent"))
            page = context.new_page()
            page.set_default_timeout(int(timeout * 1000))

            collected = []
            def handle_response(resp):
                try:
                    ctype = resp.headers.get('content-type', '')
                    if 'application/json' in ctype and 'realtor.com' in resp.url:
                        js = resp.json()
                        collected.append({'url': resp.url, 'json': js})
                except Exception:
                    pass
            page.on('response', handle_response)

            page.goto(target_url, wait_until='domcontentloaded')
            # Try to accept cookie banners if present
            try:
                page.locator("button:has-text('Accept')").first.click(timeout=2000)
            except Exception:
                pass
            # Progressive wait: try selectors, then scroll to load more
            selectors = [
                '[data-testid="property-card"]',
                '[data-testid="search-result-element"]',
                'li[data-testid="result-card"]',
            ]
            found = False
            for sel in selectors:
                try:
                    page.wait_for_selector(sel, timeout=int(timeout * 1000))
                    found = True
                    break
                except Exception:
                    continue
            # Attempt incremental scrolling to trigger lazy-loaded results
            for _ in range(max_scrolls):
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                page.wait_for_timeout(1500)
            html = page.content()
            browser.close()
            return html, collected
    else:
        raise ValueError("Unknown engine: %s" % engine)


def main():
    parser = argparse.ArgumentParser(description='Scrape Realtor listings to CSV')
    parser.add_argument('--city', default='Stockton_CA', help='City slug, e.g., Stockton_CA')
    parser.add_argument('--output', default='housing.csv', help='Output CSV path (e.g., data/housing.csv)')
    parser.add_argument('--timeout', type=float, default=20.0)
    parser.add_argument('--engine', choices=['requests', 'browser'], default='requests', help='Fetch via requests or headless browser')
    parser.add_argument('--headless', type=lambda x: str(x).lower() != 'false', default=True, help='Set to false to run a visible browser')
    args = parser.parse_args()

    target_url = build_url(args.city)
    if args.engine == 'browser':
        html, collected = fetch_html(args.engine, target_url, args.timeout, headless=args.headless)
    else:
        html = fetch_html(args.engine, target_url, args.timeout)
        collected = []
    soup = BeautifulSoup(html, 'html.parser')

    cards = find_listings(soup)
    rows = [parse_card(c) for c in cards] if cards else []
    if not rows:
        # Fallback: try JSON-LD if available
        rows = extract_from_json_ld(soup)
    if not rows and collected:
        rows = extract_from_collected_json(collected)

    write_csv(rows, args.output)


if __name__ == '__main__':
    main()
