/**
 * Real estate deal dashboard — Worker API + RentCast ingest & enrichment.
 * PropStream-style layer on licensed RentCast data.
 *
 * Routes:
 *   GET  /api/listings    filter/search listings incl. deal filters -> JSON
 *   GET  /api/stats       summary for the dashboard                 -> JSON
 *   GET  /api/budget      RentCast calls used this month vs cap     -> JSON
 *   GET  /api/export.csv  current filter set as a lead-list CSV     -> CSV
 *   POST /api/ingest      push rows manually (Bearer)               -> JSON
 *   POST /api/refresh     pull sale listings from RentCast (Bearer) -> JSON
 *   POST /api/enrich      enrich ONE listing (Bearer): owner record + AVM
 *                         value + rent estimate = 3 RentCast calls  -> JSON
 *
 * Budget: every RentCast call increments api_usage for the current month.
 * When calls would exceed RENTCAST_MONTHLY_CAP (var, default 50 = free tier),
 * RentCast-calling routes refuse with 429 instead of silently spending.
 *
 * Secrets/vars: INGEST_TOKEN, RENTCAST_API_KEY (secrets);
 *               CITIES, RENTCAST_MONTHLY_CAP (vars).
 */

interface Env {
  DB: D1Database;
  INGEST_TOKEN: string;
  RENTCAST_API_KEY: string;
  CITIES?: string;
  RENTCAST_MONTHLY_CAP?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

type Row = Record<string, unknown>;

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

/* ---------------- budget guard ---------------- */

function monthKey(): string { return new Date().toISOString().slice(0, 7); }

async function getBudget(env: Env) {
  const cap = parseInt(env.RENTCAST_MONTHLY_CAP || "50", 10) || 50;
  const row = await env.DB.prepare("SELECT calls FROM api_usage WHERE month = ?")
    .bind(monthKey()).first<{ calls: number }>();
  return { month: monthKey(), used: row?.calls ?? 0, cap };
}

/** Reserve n RentCast calls; throws a budget error if the cap would be exceeded. */
async function reserveCalls(env: Env, n: number) {
  const b = await getBudget(env);
  if (b.used + n > b.cap) {
    throw Object.assign(
      new Error(`RentCast budget: ${b.used}/${b.cap} used this month; ${n} more would exceed the cap. Raise RENTCAST_MONTHLY_CAP only if you accept the RentCast paid tier.`),
      { budget: true }
    );
  }
  await env.DB.prepare(
    "INSERT INTO api_usage (month, calls) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET calls = calls + excluded.calls"
  ).bind(monthKey(), n).run();
}

/* ---------------- RentCast fetchers ---------------- */

async function rcGet(env: Env, path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params);
  const resp = await fetch(`https://api.rentcast.io/v1${path}?${qs}`, {
    headers: { "X-Api-Key": env.RENTCAST_API_KEY, accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`RentCast ${path} ${resp.status}: ${(await resp.text()).slice(0, 180)}`);
  return resp.json();
}

async function fetchSaleListings(env: Env, city: string, state: string, limit = 500): Promise<Row[]> {
  const data = await rcGet(env, "/listings/sale", {
    city, state, status: "Active", limit: String(Math.min(Math.max(limit, 1), 500)),
  });
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
    };
  });
}

/* ---------------- enrichment (the PropStream layer) ---------------- */

/** Normalize an address for absentee comparison: case/punct/whitespace-insensitive. */
function normAddr(a: string | null | undefined): string {
  return (a || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface EnrichSource { property: any; value: any; rent: any; }

/** Fetch the 3 RentCast records for an address (3 budget calls). */
async function fetchEnrichment(env: Env, address: string): Promise<EnrichSource> {
  await reserveCalls(env, 3);
  const [propArr, value, rent] = await Promise.all([
    rcGet(env, "/properties", { address }),
    rcGet(env, "/avm/value", { address, compCount: "10" }),
    rcGet(env, "/avm/rent/long-term", { address, compCount: "10" }),
  ]);
  const property = Array.isArray(propArr) ? propArr[0] : propArr;
  return { property, value, rent };
}

/** Compute + store enrichment for one listing row. Returns the stored fields. */
async function applyEnrichment(env: Env, id: number, location: string, priceNum: number | null, src: EnrichSource) {
  const p = src.property || {};
  const v = src.value || {};
  const r = src.rent || {};

  const ownerNames: string[] = p.owner?.names ?? [];
  const ownerType: string | null = p.owner?.type ?? null;
  const ownerMailing: string | null = p.owner?.mailingAddress?.formattedAddress ?? null;
  const absentee = ownerMailing ? (normAddr(ownerMailing) !== normAddr(location) ? 1 : 0) : null;
  const corporate = ownerType ? (ownerType.toLowerCase() === "individual" ? 0 : 1) : null;

  const avm: number | null = v.price ?? null;
  const rentEst: number | null = r.rent ?? null;
  const discount = avm && priceNum ? ((avm - priceNum) / avm) * 100 : null;
  const yieldPct = rentEst && priceNum ? ((rentEst * 12) / priceNum) * 100 : null;

  const comps = (v.comparables ?? []).slice(0, 5).map((c: any) => ({
    address: c.formattedAddress, price: c.price, sqft: c.squareFootage,
    bed: c.bedrooms, bath: c.bathrooms, distance: c.distance, correlation: c.correlation,
  }));

  const fields = {
    owner_names: JSON.stringify(ownerNames),
    owner_type: ownerType,
    owner_mailing: ownerMailing,
    absentee, corporate_owner: corporate,
    last_sale_date: p.lastSaleDate ?? null,
    last_sale_price: p.lastSalePrice ?? null,
    year_built: p.yearBuilt ?? null,
    avm_value: avm, avm_low: v.priceRangeLow ?? null, avm_high: v.priceRangeHigh ?? null,
    rent_est: rentEst, rent_low: r.rentRangeLow ?? null, rent_high: r.rentRangeHigh ?? null,
    discount_pct: discount != null ? Math.round(discount * 10) / 10 : null,
    gross_yield_pct: yieldPct != null ? Math.round(yieldPct * 10) / 10 : null,
    comps_json: JSON.stringify(comps),
  };

  await env.DB.prepare(
    `UPDATE listings SET owner_names=?, owner_type=?, owner_mailing=?, absentee=?, corporate_owner=?,
       last_sale_date=?, last_sale_price=?, year_built=?, avm_value=?, avm_low=?, avm_high=?,
       rent_est=?, rent_low=?, rent_high=?, discount_pct=?, gross_yield_pct=?, comps_json=?,
       enriched_at=datetime('now')
     WHERE id=?`
  ).bind(
    fields.owner_names, fields.owner_type, fields.owner_mailing, fields.absentee, fields.corporate_owner,
    fields.last_sale_date, fields.last_sale_price, fields.year_built, fields.avm_value, fields.avm_low, fields.avm_high,
    fields.rent_est, fields.rent_low, fields.rent_high, fields.discount_pct, fields.gross_yield_pct, fields.comps_json,
    id
  ).run();

  return fields;
}

/* ---------------- ingest/upsert ---------------- */

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

async function refreshCities(env: Env, cities: Array<{ city: string; state: string }>) {
  const refreshed: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const { city, state } of cities) {
    const slug = `${city}_${state}`;
    try {
      await reserveCalls(env, 1);
      const rows = await fetchSaleListings(env, city, state);
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

/* ---------------- listing query (shared by /api/listings and export) ---------------- */

const LISTING_COLS =
  `id, city, location, status, price_text, price_num, owner, bed, bath, sqft, sqft_lot,
   property_type, days_on_market, listed_date, price_per_sqft,
   owner_names, owner_type, owner_mailing, absentee, corporate_owner,
   last_sale_date, last_sale_price, year_built, avm_value, avm_low, avm_high,
   rent_est, rent_low, rent_high, discount_pct, gross_yield_pct, comps_json, enriched_at, scraped_at`;

function buildListingQuery(p: URLSearchParams) {
  const where: string[] = [];
  const binds: unknown[] = [];
  const city = p.get("city"); if (city) { where.push("city = ?"); binds.push(city); }
  const q = p.get("q"); if (q) { where.push("(location LIKE ? OR owner LIKE ?)"); binds.push(`%${q}%`, `%${q}%`); }
  const min = p.get("min_price"); if (min) { where.push("price_num >= ?"); binds.push(parseInt(min, 10)); }
  const max = p.get("max_price"); if (max) { where.push("price_num <= ?"); binds.push(parseInt(max, 10)); }
  const beds = p.get("beds"); if (beds) { where.push("CAST(bed AS INTEGER) >= ?"); binds.push(parseInt(beds, 10)); }
  const ptype = p.get("type"); if (ptype) { where.push("property_type = ?"); binds.push(ptype); }
  // deal filters
  if (p.get("absentee") === "1") where.push("absentee = 1");
  if (p.get("corporate") === "1") where.push("corporate_owner = 1");
  const mdisc = p.get("min_discount"); if (mdisc) { where.push("discount_pct >= ?"); binds.push(parseFloat(mdisc)); }
  const myield = p.get("min_yield"); if (myield) { where.push("gross_yield_pct >= ?"); binds.push(parseFloat(myield)); }
  if (p.get("enriched") === "1") where.push("enriched_at IS NOT NULL");

  const limit = Math.min(parseInt(p.get("limit") || "200", 10) || 200, 1000);
  const sortCol = ({
    price: "price_num", scraped: "scraped_at", ppsf: "price_per_sqft", dom: "days_on_market",
    discount: "discount_pct", yield: "gross_yield_pct", value: "avm_value",
  } as Record<string, string>)[p.get("sort") || ""] || "scraped_at";
  const dir = (p.get("dir") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sql = `SELECT ${LISTING_COLS} FROM listings
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ${sortCol} ${dir} NULLS LAST LIMIT ?`;
  binds.push(limit);
  return { sql, binds };
}

/* ---------------- handlers ---------------- */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS });

    try {
      if (pathname === "/api/listings" && request.method === "GET") {
        const { sql, binds } = buildListingQuery(url.searchParams);
        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        return json({ count: results.length, listings: results });
      }

      if (pathname === "/api/stats" && request.method === "GET") return await stats(env);
      if (pathname === "/api/budget" && request.method === "GET") return json(await getBudget(env));

      if (pathname === "/api/export.csv" && request.method === "GET") {
        const { sql, binds } = buildListingQuery(url.searchParams);
        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        const cols = ["location", "city", "status", "price_num", "avm_value", "discount_pct", "rent_est",
                      "gross_yield_pct", "bed", "bath", "sqft", "year_built", "days_on_market",
                      "owner_names", "owner_type", "owner_mailing", "absentee", "corporate_owner",
                      "last_sale_date", "last_sale_price"];
        const escCsv = (v: unknown) => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
        const csv = [cols.join(","), ...results.map((r: any) => cols.map((c) => escCsv(r[c])).join(","))].join("\n");
        return new Response(csv, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="leads-${monthKey()}.csv"`,
            "access-control-allow-origin": "*",
          },
        });
      }

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

      if (pathname === "/api/enrich" && request.method === "POST") {
        if (!authed(request, env)) return json({ error: "Unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as { id?: number; mock?: EnrichSource };
        const id = Number(body.id);
        if (!id) return json({ error: "Missing 'id'" }, 400);
        const row = await env.DB.prepare("SELECT id, location, price_num FROM listings WHERE id = ?")
          .bind(id).first<{ id: number; location: string; price_num: number | null }>();
        if (!row) return json({ error: `No listing with id ${id}` }, 404);

        let src: EnrichSource;
        if (body.mock) {
          // Documented test hook (Bearer-protected): verify the compute/store
          // pipeline without spending RentCast calls. Never fabricates data in
          // the UI — enriched_at marks it stored, and the payload is caller-supplied.
          src = body.mock;
        } else {
          if (!env.RENTCAST_API_KEY) return json({ error: "RENTCAST_API_KEY not set" }, 500);
          try {
            src = await fetchEnrichment(env, row.location);
          } catch (e: any) {
            return json({ error: String(e?.message || e) }, e?.budget ? 429 : 502);
          }
        }
        const fields = await applyEnrichment(env, row.id, row.location, row.price_num, src);
        return json({ ok: true, id: row.id, enriched: fields, budget: await getBudget(env) });
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

async function stats(env: Env): Promise<Response> {
  const total = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(enriched_at IS NOT NULL) AS enriched FROM listings").first<{ n: number; enriched: number }>();
  const cities = await env.DB.prepare("SELECT city, COUNT(*) AS n FROM listings GROUP BY city ORDER BY n DESC").all();
  const price = await env.DB.prepare(
    "SELECT AVG(price_num) AS avg, MIN(price_num) AS min, MAX(price_num) AS max, AVG(price_per_sqft) AS avg_ppsf, AVG(gross_yield_pct) AS avg_yield FROM listings WHERE price_num IS NOT NULL"
  ).first<{ avg: number; min: number; max: number; avg_ppsf: number; avg_yield: number }>();
  const types = await env.DB.prepare("SELECT property_type, COUNT(*) AS n FROM listings WHERE property_type IS NOT NULL GROUP BY property_type ORDER BY n DESC").all();
  const last = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_ingest'").first<{ value: string }>();
  return json({
    total: total?.n ?? 0,
    enriched: total?.enriched ?? 0,
    cities: cities.results,
    types: types.results,
    price: price ?? { avg: null, min: null, max: null, avg_ppsf: null, avg_yield: null },
    last_ingest: last?.value ?? null,
    budget: await getBudget(env),
  });
}
