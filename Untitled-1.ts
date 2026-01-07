// chapala-scraper.ts
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

type Listing = {
  listingId: string;           // numeric from URL
  canonicalUrl: string;
  title: string | null;
  address: string | null;
  priceText: string | null;
  priceCurrency: 'MXN' | 'USD' | 'CAD' | 'EUR' | null;
  price: number | null;
  status: string | null;       // e.g., For Sale
  propertyType: string | null; // Residential, Commercial, Land and Lots, etc.
  subdivision: string | null;  // "Subdivision"
  region: string | null;       // Region or neighborhood
  beds: number | null;
  baths: number | null;
  halfBaths: number | null;
  floors: number | null;
  const_m2: number | null;     // Construction m²
  lot_m2: number | null;       // Lot m²
  furnished: string | null;
  view: string | null;
  gated: string | null;
  agentName: string | null;
  officeName: string | null;
  agentPhones: string[];
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toNumber(txt: string | null): number | null {
  if (!txt) return null;
  const clean = txt.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const num = Number(clean);
  return Number.isFinite(num) ? num : null;
}

function first<T>(arr: T[] | null | undefined): T | null {
  return arr && arr.length ? arr[0] : null;
}

/** CSV with header, escaping via JSON.stringify for cells */
function toCSV(rows: Record<string, any>[]): string {
  const headers = Array.from(
    rows.reduce((s, r) => {
      Object.keys(r).forEach((k) => s.add(k));
      return s;
    }, new Set<string>())
  );
  const lines = [
    headers.join(','),
    ...rows.map((r) =>
      headers
        .map((h) => {
          const v = r[h];
          return JSON.stringify(v ?? '');
        })
        .join(',')
    ),
  ];
  return lines.join('\n');
}

/** Pulls "Key: Value" style fields by label text anywhere on the page */
async function getByLabel(page, label: string): Promise<string | null> {
  return page.evaluate((needle) => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const isMatch = (s: string) => norm(s).toLowerCase().startsWith(needle.toLowerCase());
    // scan for "Property Type:", "Beds:", etc.
    const walkers = Array.from(document.querySelectorAll('*, * *'));
    for (const el of walkers) {
      const t = el.textContent || '';
      if (!t) continue;
      const txt = norm(t);
      if (isMatch(txt)) {
        // try immediate text after the colon
        const after = txt.split(':').slice(1).join(':').trim();
        if (after) return after;
        // try the next sibling element’s text
        const sib = (el.nextElementSibling as HTMLElement) || null;
        if (sib && sib.textContent) return norm(sib.textContent);
      }
    }
    // fallback: regex on full body text
    const body = norm(document.body.innerText || '');
    const m = body.match(new RegExp(`${needle.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*([^\\n]+)`,'i'));
    return m ? norm(m[1]) : null;
  }, label);
}

/** First currency/price hit like 'MXN $ 5,250,000' or 'USD $ 277,500' */
async function getPrice(page): Promise<{ text: string | null; currency: Listing['priceCurrency']; value: number | null; }> {
  const text = await page.evaluate(() => {
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const m = body.match(/\b(MXN|USD|CAD|EUR)\s*\$\s*[\d.,]+/i);
    return m ? m[0] : null;
  });
  const currency = (text?.match(/\b(MXN|USD|CAD|EUR)\b/i)?.[1]?.toUpperCase() as Listing['priceCurrency']) ?? null;
  const value = toNumber(text ?? null);
  return { text, currency, value };
}

/** Agent phones: attempt tel: links first, then visible numbers near 'Agent Info' */
async function getAgentPhones(page): Promise<string[]> {
  const telHrefs: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href^="tel:"]'))
      .map((a) => a.getAttribute('href') || '')
      .filter(Boolean)
  );
  if (telHrefs.length) {
    return telHrefs.map((h) => h.replace(/^tel:/, '').trim());
  }
  // fallback: regex sweep
  const block = await page.evaluate(() => {
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const body = normalize(document.body?.innerText || '');
    // try to slice around "Agent Info"
    const idx = body.toLowerCase().indexOf('agent info');
    return idx >= 0 ? body.slice(idx, idx + 800) : body;
  });
  const matches = block.match(/(\+?\s*\d[\d\s().-]{7,})/g) || [];
  return Array.from(
    new Set(
      matches
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .map((s) => s.replace(/[^\d+().\-\s]/g, ''))
    )
  );
}

function listingIdFromUrl(url: string): string {
  const m = url.match(/-(\d+)(?:$|\?)/);
  return m ? m[1] : url;
}

async function extractDetail(page, url: string): Promise<Listing> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Title + address from the hero area (robust fallback to <title>)
  const title = await page.evaluate(() => {
    const h = document.querySelector('h1, h2, .page-title');
    if (h?.textContent) return h.textContent.trim();
    return document.title || null;
  });
  const address = await page.evaluate(() => {
    // Address tends to sit under the title
    const candidate = Array.from(document.querySelectorAll('h1, h2, .page-title'))
      .map((el) => el.parentElement)
      .filter(Boolean)
      .map((el) => el!.textContent || '')
      .find((txt) => /\d{4,5},/.test(txt) || /Jalisco|Chapala|Ajijic|Jocotepec/i.test(txt));
    return candidate ? candidate.replace(/\s+/g, ' ').trim() : null;
  });

  const { text: priceText, currency: priceCurrency, value: price } = await getPrice(page);

  // Label-based fields (detail page shows consistent labels)
  const status        = await getByLabel(page, 'Property Status:');
  const propertyType  = await getByLabel(page, 'Property Type:');
  const subdivision   = await getByLabel(page, 'Subdivision');
  const region        = await getByLabel(page, 'Region');
  const beds          = toNumber(await getByLabel(page, 'Beds:'));
  const baths         = toNumber(await getByLabel(page, 'Baths:'));
  const halfBaths     = toNumber(await getByLabel(page, 'Half Baths:'));
  const floors        = toNumber(await getByLabel(page, 'Floors:'));
  const const_m2      = toNumber(await getByLabel(page, 'Construction m²:'));
  const lot_m2        = toNumber(await getByLabel(page, 'Lot m²:'));
  const furnished     = await getByLabel(page, 'Furnished:');
  const view          = await getByLabel(page, 'View:');
  const gated         = await getByLabel(page, 'Gated Comm');

  // Agent + office names (detail shows "Agent Info" block)
  const agentName = await page.evaluate(() => {
    // Grab the first strong text near "Agent Info"
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const all = Array.from(document.querySelectorAll('*')).map((el) => norm(el.textContent || ''));
    const agentIdx = all.findIndex((t) => /agent info/i.test(t));
    if (agentIdx >= 0) {
      const window = all.slice(agentIdx, agentIdx + 50).join(' | ');
      const m = window.match(/Name:\s*([^|]+)/i);
      if (m) return norm(m[1]);
    }
    // Fallback: first person-like line before "License:"
    const allTxt = norm(document.body?.innerText || '');
    const m2 = allTxt.match(/Agent Info\s+(.+?)\s+License:/i);
    return m2 ? norm(m2[1]) : null;
  });

  const officeName = await page.evaluate(() => {
    const imgAlts = Array.from(document.querySelectorAll('img[alt]')).map((img) => img.getAttribute('alt') || '');
    const hit = imgAlts.find((a) => /real estate|chapala|realt(y|or)|group|properties/i.test(a));
    return hit || null;
  });

  const agentPhones = await getAgentPhones(page);

  return {
    listingId: listingIdFromUrl(url),
    canonicalUrl: url,
    title,
    address,
    priceText,
    priceCurrency,
    price,
    status,
    propertyType,
    subdivision,
    region,
    beds,
    baths,
    halfBaths,
    floors,
    const_m2,
    lot_m2,
    furnished,
    view,
    gated,
    agentName,
    officeName,
    agentPhones,
  };
}

export default async function scrapeChapala({
  headless = true,
  maxPages = Infinity,
  delayMs = 600, // gentle on the server
  persistAuthDir, // e.g. '.auth/chapala' to reuse login
}: {
  headless?: boolean;
  maxPages?: number;
  delayMs?: number;
  persistAuthDir?: string;
} = {}): Promise<Listing[]> {
  const user = process.env.CHAPALA_USER || '';
  const pass = process.env.CHAPALA_PASS || '';
  const base = (process.env.CHAPALA_BASE || 'https://www.chapalamls.net').replace(/\/+$/, '');
  const resultsUrl = `${base}/en/properties/recently-added`;
  const listings: Listing[] = [];

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext(
    persistAuthDir ? { storageState: path.resolve(persistAuthDir, 'state.json') } : {}
  );
  const page = await context.newPage();

  // Optional login
  if (user && pass) {
    await page.goto(`${base}/en/`, { waitUntil: 'domcontentloaded' });
    try {
      // Try the common username/password names (site shows "Username *" and "Password *")
      await page.fill('input[name="username"], input[name="email"], input#username', user);
      await page.fill('input[name="password"], input#password', pass);
      await Promise.all([
        page.click('button[type="submit"], input[type="submit"]'),
        page.waitForLoadState('domcontentloaded'),
      ]);
      if (persistAuthDir) {
        await fs.mkdir(persistAuthDir, { recursive: true });
        await context.storageState({ path: path.resolve(persistAuthDir, 'state.json') });
      }
    } catch {
      // Non-fatal; public list pages are accessible without login.
    }
  }

  // Pagination control
  let offset = 0;
  let pageCount = 0;
  let total = Infinity; // we'll parse it from the first page
  const perPageFallback = 20;

  while (pageCount < maxPages && offset < total) {
    const url = `${resultsUrl}${offset ? `?start=${offset}` : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Parse "Result(s) X - Y of N" to learn total & per-page
    const meta = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' '));
    const m = meta.match(/Result\(s\)\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i); // e.g., "Result(s) 0 - 20 of 944"
    let step = perPageFallback;
    if (m) {
      const start = parseInt(m[1], 10);
      const end = parseInt(m[2], 10);
      const tot = parseInt(m[3], 10);
      total = Number.isFinite(tot) ? tot : total;
      const calc = end - start;
      if (Number.isFinite(calc) && calc > 0) step = calc;
    }

    // Harvest detail links on this page: /en/properties/...-NNNNN
    const hrefs: string[] = await page.evaluate(() => {
      const makeAbs = (h: string) => {
        try { return new URL(h, location.origin).href; } catch { return h; }
      };
      const re = /\/en\/properties\/[^?#]+-\d+$/;
      const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const hits = anchors
        .map((a) => a.getAttribute('href') || '')
        .filter((h) => re.test(h));
      return Array.from(new Set(hits.map(makeAbs)));
    });

    if (!hrefs.length) {
      // No links? Either end or a layout change—bail hard.
      break;
    }

    // Visit each detail (sequential w/ small delay; turn up if you want)
    for (const href of hrefs) {
      try {
        const detailPage = await context.newPage();
        const row = await extractDetail(detailPage, href);
        listings.push(row);
        await detailPage.close();
        await sleep(delayMs + Math.floor(Math.random() * 250));
      } catch (err) {
        console.error(`Failed on ${href}:`, err);
      }
    }

    offset += step;
    pageCount += 1;
  }

  await browser.close();
  return listings;
}

// If run directly: write JSON + CSV
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const outDir = process.env.OUT_DIR || 'out';
    await fs.mkdir(outDir, { recursive: true });
    const data = await scrapeChapala({
      headless: true,
      delayMs: Number(process.env.DELAY_MS || 600),
      maxPages: Number(process.env.MAX_PAGES || Infinity),
      persistAuthDir: process.env.AUTH_DIR, // e.g., ".auth/chapala"
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(outDir, `chapala-listings-${stamp}.json`);
    const csvPath  = path.join(outDir, `chapala-listings-${stamp}.csv`);
    await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.writeFile(csvPath, toCSV(data as any), 'utf8');
    console.log(`Wrote ${data.length} rows:\n- ${jsonPath}\n- ${csvPath}`);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
