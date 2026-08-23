/**
 * Real estate listings dashboard — Worker API + scheduled RentCast ingest.
 *
 * HTTP routes (everything under /api/*; other paths are static assets):
 *   GET  /api/listings   filter/search stored listings   -> JSON
 *   GET  /api/stats      summary counts for the dashboard -> JSON
 *   POST /api/ingest     push rows manually (Bearer token)-> JSON
 *   POST /api/refresh    pull from RentCast now (Bearer)  -> JSON  (?city=&state= or uses CITIES)
 *
 * Cron (wrangler.jsonc triggers): scheduled() refreshes every city in CITIES.
 * Each city is ONE RentCast call (limit 500), so daily × 1 city ≈ 30 calls/mo —
 * inside RentCast's 50-call free tier.
 *
 * Secrets/vars:
 *   INGEST_TOKEN      (secret) protects /api/ingest and /api/refresh
 *   RENTCAST_API_KEY  (secret) licensed data source
 *   CITIES            (var)    "Stockton,CA;Shelby,NC" — cities the cron refreshes
 */

interface Env {
  DB: D1Database;
  INGEST_TOKEN: string;
  RENTCAST_API_KEY: string;
  CITIES?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

type Row = Record<string, string | number | null>;

function parseNum(text: unknown): number | null {
  if (text == null) return null;
  const t = String(text).trim().toLowerCase().replace(/[$,\s]/g, "");
  const m = t.match(/([0-9]*\.?[0-9]+)([km])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  if (m[2] === "k") n *= 1_000;
  if (m[2] === "m") n *= 1_000_000;
  return Math.round(n);
}

/** Fetch active sale listings for one city from RentCast, mapped to our schema. */
async function fetchRentCast(apiKey: string, city: string, state: string, limit = 500): Promise<Row[]> {
  const qs = new URLSearchParams({ city, state, status: "Active", limit: String(Math.min(Math.max(limit, 1), 500)) });
  const resp = await fetch(`https://api.rentcast.io/v1/listings/sale?${qs}`, {
    headers: { "X-Api-Key": apiKey, accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`RentCast ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const items: any[] = Array.isArray(data) ? data : (data.listings ?? data.data ?? []);
  return items.filter((it) => it && typeof it === "object").map((it) => {
    const agent = it.listingAgent || {};
    const office = it.listingOffice || {};
    const s = (v: unknown) => (v == null ? null : String(v));
    return {
      location: it.formattedAddress ?? "Not specified",
      status: it.status ?? "Not specified",
      price: s(it.price) ?? "Not specified",
      owner: agent.name || office.name || "Not specified",
      bed: s(it.bedrooms) ?? "NoV",
      bath: s(it.bathrooms) ?? "NoV",
      sqft: s(it.squareFootage) ?? "NoV",
      sqft_lot: s(it.lotSize) ?? "NoV",
      property_type: s(it.propertyType),
      days_on_market: it.daysOnMarket != null ? Number(it.daysOnMarket) : null,
      listed_date: s(it.listedDate),
    } as Row;
  });
}

/** Upsert a batch of rows for one city slug. Returns count. */
async function upsertListings(env: Env, citySlug: string, rows: Row[]): Promise<number> {
  const stmt = env.DB.prepare(
    `INSERT INTO listings (city, location, status, price_text, price_num, owner, bed, bath, sqft, sqft_lot,
                           property_type, days_on_market, listed_date, sqft_num, price_per_sqft, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(city, location) DO UPDATE SET
       status=excluded.status, price_text=excluded.price_text, price_num=excluded.price_num,
       owner=excluded.owner, bed=excluded.bed, bath=excluded.bath, sqft=excluded.sqft,
       sqft_lot=excluded.sqft_lot, property_type=excluded.property_type,
       days_on_market=excluded.days_on_market, listed_date=excluded.listed_date,
       sqft_num=excluded.sqft_num, price_per_sqft=excluded.price_per_sqft,
       scraped_at=excluded.scraped_at`
  );
  const g = (r: Row, a: string, b: string) => (r[a] ?? r[b] ?? null) as string | null;
  const batch = rows
    .filter((r) => r.location || r.Location)
    .map((r) => {
      const priceText = g(r, "price", "Price");
      const priceNum = parseNum(priceText);
      const sqftNum = parseNum(g(r, "sqft", "SQFT"));
      const ppsf = priceNum && sqftNum ? Math.round(priceNum / sqftNum) : null;
      return stmt.bind(
        citySlug, g(r, "location", "Location"), g(r, "status", "Status"),
        priceText, priceNum, g(r, "owner", "Owner"),
        g(r, "bed", "Bed"), g(r, "bath", "Bath"), g(r, "sqft", "SQFT"), g(r, "sqft_lot", "SQFT_LOT"),
        (r.property_type as string) ?? null,
        (r.days_on_market as number) ?? null,
        (r.listed_date as string) ?? null,
        sqftNum, ppsf
      );
    });
  if (!batch.length) return 0;
  await env.DB.batch([
    ...batch,
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('last_ingest', datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  ]);
  return batch.length;
}

function parseCities(raw: string | undefined): Array<{ city: string; state: string }> {
  return (raw || "")
    .split(";").map((s) => s.trim()).filter(Boolean)
    .map((pair) => { const [city, state] = pair.split(",").map((x) => x.trim()); return { city, state }; })
    .filter((c) => c.city && c.state);
}

/** Refresh each city independently — one bad city doesn't sink the rest. */
async function refreshCities(env: Env, cities: Array<{ city: string; state: string }>) {
  const refreshed: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const { city, state } of cities) {
    const slug = `${city}_${state}`;
    try {
      const rows = await fetchRentCast(env.RENTCAST_API_KEY, city, state);
      refreshed[slug] = await upsertListings(env, slug, rows);
    } catch (e: any) {
      errors[slug] = String(e?.message || e);
    }
  }
  return { refreshed, errors };
}

function authed(request: Request, env: Env): boolean {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return !!env.INGEST_TOKEN && token === env.INGEST_TOKEN;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS });

    try {
      if (pathname === "/api/listings" && request.method === "GET") return await listListings(url, env);
      if (pathname === "/api/stats" && request.method === "GET") return await stats(env);

      if (pathname === "/api/ingest" && request.method === "POST") {
        if (!authed(request, env)) return json({ error: "Unauthorized" }, 401);
        const body = (await request.json()) as { city?: string; rows?: Row[] };
        const city = (String(body.city || "")).trim();
        if (!city) return json({ error: "Missing 'city'" }, 400);
        const n = await upsertListings(env, city, Array.isArray(body.rows) ? body.rows : []);
        return json({ ok: true, city, ingested: n });
      }

      if (pathname === "/api/refresh" && request.method === "POST") {
        if (!authed(request, env)) return json({ error: "Unauthorized" }, 401);
        if (!env.RENTCAST_API_KEY) return json({ error: "RENTCAST_API_KEY not set" }, 500);
        const city = url.searchParams.get("city");
        const state = url.searchParams.get("state");
        const cities = city && state ? [{ city, state }] : parseCities(env.CITIES);
        if (!cities.length) return json({ error: "No cities: pass ?city=&state= or set CITIES var" }, 400);
        const result = await refreshCities(env, cities);
        const ok = Object.keys(result.errors).length === 0;
        return json({ ok, ...result }, ok ? 200 : 207);
      }
    } catch (err: any) {
      return json({ error: String(err?.message || err) }, 500);
    }
    return json({ error: "Not found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cities = parseCities(env.CITIES);
    if (!cities.length || !env.RENTCAST_API_KEY) return;
    ctx.waitUntil(refreshCities(env, cities).then((r) => console.log("cron refresh:", JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;

async function listListings(url: URL, env: Env): Promise<Response> {
  const p = url.searchParams;
  const where: string[] = [];
  const binds: unknown[] = [];
  const city = p.get("city"); if (city) { where.push("city = ?"); binds.push(city); }
  const q = p.get("q"); if (q) { where.push("(location LIKE ? OR owner LIKE ?)"); binds.push(`%${q}%`, `%${q}%`); }
  const min = p.get("min_price"); if (min) { where.push("price_num >= ?"); binds.push(parseInt(min, 10)); }
  const max = p.get("max_price"); if (max) { where.push("price_num <= ?"); binds.push(parseInt(max, 10)); }
  const beds = p.get("beds"); if (beds) { where.push("CAST(bed AS INTEGER) >= ?"); binds.push(parseInt(beds, 10)); }
  const ptype = p.get("type"); if (ptype) { where.push("property_type = ?"); binds.push(ptype); }
  const limit = Math.min(parseInt(p.get("limit") || "200", 10) || 200, 1000);
  const sortCol = ({ price: "price_num", scraped: "scraped_at", ppsf: "price_per_sqft", dom: "days_on_market" } as Record<string, string>)[p.get("sort") || ""] || "scraped_at";
  const dir = (p.get("dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sql =
    `SELECT city, location, status, price_text, price_num, owner, bed, bath, sqft, sqft_lot,
            property_type, days_on_market, listed_date, price_per_sqft, scraped_at
     FROM listings ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ${sortCol} ${dir} LIMIT ?`;
  binds.push(limit);
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json({ count: results.length, listings: results });
}

async function stats(env: Env): Promise<Response> {
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>();
  const cities = await env.DB.prepare("SELECT city, COUNT(*) AS n FROM listings GROUP BY city ORDER BY n DESC").all();
  const price = await env.DB.prepare("SELECT AVG(price_num) AS avg, MIN(price_num) AS min, MAX(price_num) AS max, AVG(price_per_sqft) AS avg_ppsf FROM listings WHERE price_num IS NOT NULL").first<{ avg: number; min: number; max: number; avg_ppsf: number }>();
  const types = await env.DB.prepare("SELECT property_type, COUNT(*) AS n FROM listings WHERE property_type IS NOT NULL GROUP BY property_type ORDER BY n DESC").all();
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_ingest'").first<{ value: string }>();
  return json({
    total: total?.n ?? 0,
    cities: cities.results,
    types: types.results,
    price: price ?? { avg: null, min: null, max: null, avg_ppsf: null },
    last_ingest: last?.value ?? null,
  });
}
