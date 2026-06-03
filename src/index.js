/**
 * FinanceNinja API Proxy — Cloudflare Worker index.js
 * -----------------------------------------------------------------------------
 * GitHub-ready Worker entry file for:
 *   - index.html portfolio hub
 *   - usa_macro_outlook_trend_analysis.html
 *
 * Deploy target:
 *   Cloudflare Workers / Cloudflare Pages with Worker-style entry point.
 *
 * Required secrets in Cloudflare:
 *   FRED_API_KEY
 *
 * Recommended optional secrets:
 *   BLS_API_KEY
 *   EIA_API_KEY
 *   FINNHUB_API_KEY
 *   NEWSAPI_KEY
 *   BEA_API_KEY
 *
 * Main routes used by the uploaded pages:
 *   GET /api/all
 *   GET /api/fred?series_id=SP500&limit=5&sort_order=desc
 *   GET /api/fred/calendar?daysBack=7&daysForward=120&limit=250
 *   GET /api/ecocal?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET /api/news?category=general
 *   GET /api/stock-news?symbol=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET /api/earnings?tickers=AAPL,MSFT&from=YYYY-MM-DD&to=YYYY-MM-DD
 */

const ROUTES = [
  '/api/health',
  '/api/all',
  '/api/data',
  '/api/fred',
  '/api/fred/macro',
  '/api/fred/calendar',
  '/api/ecocal',
  '/api/macro',
  '/api/energy',
  '/api/labor',
  '/api/market',
  '/api/treasury',
  '/api/news',
  '/api/news/market',
  '/api/news/stocks',
  '/api/stock-news',
  '/api/earnings',
  '/api/bea/gdp',
  '/api/census/indicators',
];

const DEFAULT_TICKERS = [
  'ABBV', 'GOOGL', 'AVGO', 'LLY', 'ASML', 'DY', 'ARGX',
  'DVN', 'MDB', 'GH', 'HQY', 'SBGSY', 'MRVL'
];

const KEY_RELEASE_RE =
  /employment situation|consumer price index|producer price|personal income|gross domestic product|retail sales|housing starts|new residential|industrial production|federal reserve|fomc|beige book/i;

// FOMC does not have a clean official REST API comparable to FRED/BLS/EIA.
// This fallback keeps the portfolio calendar usable if no live economic-calendar provider is attached.
const FOMC_FALLBACK_2026 = [
  { date: '2026-01-28', event: 'FOMC rate decision' },
  { date: '2026-03-18', event: 'FOMC rate decision + Summary of Economic Projections' },
  { date: '2026-04-29', event: 'FOMC rate decision' },
  { date: '2026-06-17', event: 'FOMC rate decision + Summary of Economic Projections' },
  { date: '2026-07-29', event: 'FOMC rate decision' },
  { date: '2026-09-16', event: 'FOMC rate decision + Summary of Economic Projections' },
  { date: '2026-11-05', event: 'FOMC rate decision' },
  { date: '2026-12-16', event: 'FOMC rate decision + Summary of Economic Projections' },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    const jsonHeaders = {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheFor(path),
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed', routes: ROUTES }, 405, jsonHeaders);
    }

    try {
      let body;

      switch (path) {
        case '/api/health':
          body = {
            ok: true,
            service: 'financeninja-api-proxy',
            routes: ROUTES,
            requiredSecrets: ['FRED_API_KEY'],
            optionalSecrets: ['BLS_API_KEY', 'EIA_API_KEY', 'FINNHUB_API_KEY', 'NEWSAPI_KEY', 'BEA_API_KEY'],
            lastUpdated: new Date().toISOString(),
          };
          break;

        case '/api/all':
        case '/api/data':
          body = await fetchAll(env);
          break;

        case '/api/fred':
          body = await fetchFredProxy(env, url);
          break;

        case '/api/fred/macro':
        case '/api/macro':
          body = await fetchMacro(env);
          break;

        case '/api/fred/calendar':
          body = await fetchFredCalendar(env, url);
          break;

        case '/api/ecocal':
          body = await fetchEconomicCalendar(env, url);
          break;

        case '/api/energy':
          body = await fetchEnergy(env);
          break;

        case '/api/labor':
          body = await fetchLabor(env);
          break;

        case '/api/market':
          body = await fetchMarket(env);
          break;

        case '/api/treasury':
          body = await fetchTreasury();
          break;

        case '/api/news':
        case '/api/news/market':
          body = await fetchMarketNews(env, url);
          break;

        case '/api/news/stocks':
          body = await fetchStockNewsBatch(env, url);
          break;

        case '/api/stock-news':
          body = await fetchSingleStockNews(env, url);
          break;

        case '/api/earnings':
          body = await fetchEarnings(env, url);
          break;

        case '/api/bea/gdp':
          body = await fetchBeaGdp(env);
          break;

        case '/api/census/indicators':
          body = await fetchCensusIndicatorsViaFred(env);
          break;

        default:
          body = { error: 'Not found', path, routes: ROUTES };
          return jsonResponse(body, 404, jsonHeaders);
      }

      return jsonResponse(body, 200, jsonHeaders);
    } catch (err) {
      return jsonResponse({
        error: err?.message || String(err),
        path,
      }, 500, jsonHeaders);
    }
  },
};

// -----------------------------------------------------------------------------
// Response helpers
// -----------------------------------------------------------------------------
function normalizePath(pathname) {
  return (pathname || '/').replace(/\/+$/, '') || '/';
}

function cacheFor(path) {
  if (path.includes('/news') || path.includes('/stock-news')) return 'public, max-age=300';
  if (path.includes('/earnings') || path.includes('/calendar') || path.includes('/ecocal')) return 'public, max-age=1800';
  if (path.includes('/fred') || path.includes('/macro') || path.includes('/energy')) return 'public, max-age=900';
  return 'public, max-age=900';
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function requireEnv(env, key) {
  if (!env[key]) throw new Error(`Missing required Cloudflare secret: ${key}`);
  return env[key];
}

function getEnv(env, key) {
  return env?.[key] || '';
}

function unwrap(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function collectErrors(resultsByName) {
  const out = {};
  for (const [name, result] of Object.entries(resultsByName)) {
    if (result.status === 'rejected') {
      out[name] = result.reason?.message || String(result.reason);
    }
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function dateDaysForward(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 250)}`);
  }

  if (!res.ok) {
    const msg = data?.error || data?.message || data?.error_message || text.slice(0, 250);
    throw new Error(`HTTP ${res.status} from ${url}: ${msg}`);
  }

  return data;
}

function latestFredObservation(fredResponse) {
  const observations = fredResponse?.observations || [];
  const valid = observations.filter(o => o && o.value !== '.' && o.value !== 'NA' && o.value !== null && o.value !== undefined);
  const latest = valid[0] || null;
  const previous = valid[1] || null;
  return {
    value: latest?.value ?? null,
    date: latest?.date ?? null,
    previousValue: previous?.value ?? null,
    previousDate: previous?.date ?? null,
  };
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// -----------------------------------------------------------------------------
// FRED generic proxy + helpers
// -----------------------------------------------------------------------------
async function fetchFredProxy(env, requestUrl) {
  const key = requireEnv(env, 'FRED_API_KEY');

  const seriesId = requestUrl.searchParams.get('series_id');
  if (!seriesId) throw new Error('Missing required query parameter: series_id');

  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('series_id', seriesId);

  // Pass through safe FRED observation parameters used by the pages.
  const allowed = [
    'realtime_start', 'realtime_end',
    'limit', 'offset', 'sort_order',
    'observation_start', 'observation_end',
    'units', 'frequency', 'aggregation_method',
    'output_type', 'vintage_dates',
  ];

  for (const p of allowed) {
    const v = requestUrl.searchParams.get(p);
    if (v !== null && v !== '') url.searchParams.set(p, v);
  }

  if (!url.searchParams.has('sort_order')) url.searchParams.set('sort_order', 'desc');
  if (!url.searchParams.has('limit')) url.searchParams.set('limit', '10');

  return fetchJson(url.toString());
}

async function fetchFredSeries(env, seriesId, opts = {}) {
  const key = requireEnv(env, 'FRED_API_KEY');
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('sort_order', opts.sort_order || 'desc');
  url.searchParams.set('limit', String(opts.limit ?? 3));

  if (opts.units) url.searchParams.set('units', opts.units);
  if (opts.observation_start) url.searchParams.set('observation_start', opts.observation_start);
  if (opts.observation_end) url.searchParams.set('observation_end', opts.observation_end);

  const data = await fetchJson(url.toString());
  return latestFredObservation(data);
}

// -----------------------------------------------------------------------------
// /api/all — live snapshot bundle for macro outlook page
// -----------------------------------------------------------------------------
async function fetchAll(env) {
  const [energy, macro, labor, market, treasury, news, beaGdp, census] = await Promise.allSettled([
    fetchEnergy(env),
    fetchMacro(env),
    fetchLabor(env),
    fetchMarket(env),
    fetchTreasury(),
    fetchMarketNews(env, new URL('https://dummy.local/api/news?category=general')),
    fetchBeaGdp(env).catch(e => ({ error: e.message })),
    fetchCensusIndicatorsViaFred(env).catch(e => ({ error: e.message })),
  ]);

  return {
    energy: unwrap(energy, {}),
    macro: unwrap(macro, {}),
    labor: unwrap(labor, {}),
    market: unwrap(market, {}),
    treasury: unwrap(treasury, {}),
    news: unwrap(news, { articles: [] }),
    bea: unwrap(beaGdp, {}),
    census: unwrap(census, {}),
    errors: collectErrors({ energy, macro, labor, market, treasury, news, beaGdp, census }),
    lastUpdated: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Macro data — FRED-centered
// -----------------------------------------------------------------------------
async function fetchMacro(env) {
  const series = {
    GDPNOW: { key: 'gdpNow' },
    GDPC1: { key: 'realGdpLevel' },
    A191RL1Q225SBEA: { key: 'realGdpQoQAnnualizedOfficial' },
    SP500: { key: 'sp500' },
    VIXCLS: { key: 'vixClose' },
    UNRATE: { key: 'unemploymentRate' },
    PAYEMS: { key: 'payrollsLevel' },
    ICSA: { key: 'initialClaims' },
    CPIAUCSL: { key: 'headlineCpiYoY', units: 'pc1' },
    PCEPILFE: { key: 'corePceYoY', units: 'pc1' },
    PCEPI: { key: 'pceYoY', units: 'pc1' },
    FEDFUNDS: { key: 'fedFundsRate' },
    DGS10: { key: 'tenYearTreasuryYield' },
    GS10: { key: 'tenYearTreasuryYieldMonthly' },
    DGS2: { key: 'twoYearTreasuryYield' },
    T10Y2Y: { key: 'tenTwoSpread' },
    UMCSENT: { key: 'michiganConsumerSentiment' },
    MORTGAGE30US: { key: 'mortgage30Year' },
    PSAVERT: { key: 'personalSavingRate' },
    INDPRO: { key: 'industrialProduction' },
    RSAFS: { key: 'retailSales' },
    HOUST: { key: 'housingStarts' },
    NEWORDER: { key: 'durableGoodsNewOrders' },
    HSN1F: { key: 'newHomeSales' },
  };

  const jobs = Object.entries(series).map(async ([seriesId, cfg]) => {
    const latest = await fetchFredSeries(env, seriesId, { limit: 2, units: cfg.units });
    return { seriesId, ...cfg, ...latest };
  });

  const settled = await Promise.allSettled(jobs);
  const data = {};
  const errors = {};

  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      errors.general = result.reason?.message || String(result.reason);
      continue;
    }

    const item = result.value;
    data[item.key] = {
      value: item.value,
      numericValue: numberOrNull(item.value),
      date: item.date,
      previousValue: item.previousValue,
      previousNumericValue: numberOrNull(item.previousValue),
      previousDate: item.previousDate,
      seriesId: item.seriesId,
    };
  }

  // Derived payroll change, in thousands.
  if (data.payrollsLevel?.numericValue != null && data.payrollsLevel?.previousNumericValue != null) {
    data.payrollChangeThousands = {
      value: Math.round(data.payrollsLevel.numericValue - data.payrollsLevel.previousNumericValue),
      date: data.payrollsLevel.date,
      seriesId: 'PAYEMS',
      unit: 'thousands',
    };
    // Backward-compatible alias used in earlier page versions.
    data.payrollChg = data.payrollChangeThousands.value;
  }

  // Derived GDP QoQ annualized from real GDP level if needed.
  if (data.realGdpLevel?.numericValue != null && data.realGdpLevel?.previousNumericValue != null) {
    data.realGdpQoQAnnualized = {
      value: Number(((data.realGdpLevel.numericValue / data.realGdpLevel.previousNumericValue - 1) * 400).toFixed(1)),
      date: data.realGdpLevel.date,
      seriesId: 'GDPC1',
    };
  }

  // Backward-compatible aliases for macro page.
  data.corePCE = data.corePceYoY?.value ?? null;
  data.unemployment = data.unemploymentRate?.value ?? null;
  data.tenYear = data.tenYearTreasuryYield?.value ?? data.tenYearTreasuryYieldMonthly?.value ?? null;
  data.gdpNow = data.gdpNow || null;

  return {
    ...data,
    errors,
    lastUpdated: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Energy — FRED price series + EIA storage if EIA key exists
// -----------------------------------------------------------------------------
async function fetchEnergy(env) {
  const [brent, wti, henryHub] = await Promise.allSettled([
    fetchFredSeries(env, 'DCOILBRENTEU', { limit: 3 }),
    fetchFredSeries(env, 'DCOILWTICO', { limit: 3 }),
    fetchFredSeries(env, 'DHHNGSP', { limit: 3 }),
  ]);

  let storage = null;
  let storageError = null;

  const eiaKey = getEnv(env, 'EIA_API_KEY');
  if (eiaKey) {
    try {
      const eiaUrl = `https://api.eia.gov/v2/natural-gas/stor/wkly/data/?api_key=${encodeURIComponent(eiaKey)}&facets[duoarea][]=NUS&facets[process][]=SAB&frequency=weekly&sort[0][column]=period&sort[0][direction]=desc&length=6`;
      const eia = await fetchJson(eiaUrl);
      const rows = eia?.response?.data || [];
      const cur = rows[0] ? Number(rows[0].value) : null;
      const prev = rows[1] ? Number(rows[1].value) : null;
      const weeklyChangeBcf = Number.isFinite(cur) && Number.isFinite(prev) ? Math.round(cur - prev) : null;
      storage = cur == null ? null : {
        period: rows[0]?.period ?? null,
        bcf: cur,
        tcf: Number((cur / 1000).toFixed(2)),
        weeklyChangeBcf,
        label: `${(cur / 1000).toFixed(2)} Tcf${weeklyChangeBcf == null ? '' : ` (${weeklyChangeBcf >= 0 ? '+' : ''}${weeklyChangeBcf} Bcf WoW)`}`,
      };
    } catch (e) {
      storageError = e.message;
    }
  } else {
    storageError = 'EIA_API_KEY not configured; storage omitted.';
  }

  const out = {
    brent: unwrap(brent, null),
    wti: unwrap(wti, null),
    henryHub: unwrap(henryHub, null),
    naturalGasStorage: storage,
    storageError,
  };

  // Backward-compatible simple values.
  out.brentValue = out.brent?.value ?? null;
  out.wtiValue = out.wti?.value ?? null;
  out.henryHubValue = out.henryHub?.value ?? null;
  out.storage = storage?.label ?? null;

  return out;
}

// -----------------------------------------------------------------------------
// Labor — BLS if key exists, otherwise FRED fallback
// -----------------------------------------------------------------------------
async function fetchLabor(env) {
  const blsKey = getEnv(env, 'BLS_API_KEY');
  const out = {};

  if (blsKey) {
    try {
      const payload = {
        seriesid: ['CES0000000001', 'LNS14000000'],
        registrationkey: blsKey,
        latest: true,
      };

      const bls = await fetchJson('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      for (const s of bls?.Results?.series || []) {
        const row = s?.data?.[0];
        if (!row) continue;

        if (s.seriesID === 'CES0000000001') {
          out.totalNonfarmPayrolls = {
            value: row.value,
            numericValue: numberOrNull(row.value),
            period: `${row.year} ${row.periodName}`,
            seriesId: s.seriesID,
            unit: 'thousands',
            source: 'BLS',
          };
        }

        if (s.seriesID === 'LNS14000000') {
          out.unemploymentRate = {
            value: row.value,
            numericValue: numberOrNull(row.value),
            period: `${row.year} ${row.periodName}`,
            seriesId: s.seriesID,
            unit: 'percent',
            source: 'BLS',
          };
        }
      }
    } catch (e) {
      out.blsError = e.message;
    }
  }

  // Always include FRED fallback/latest claims.
  const [payrolls, unemployment, claims] = await Promise.allSettled([
    fetchFredSeries(env, 'PAYEMS', { limit: 2 }),
    fetchFredSeries(env, 'UNRATE', { limit: 2 }),
    fetchFredSeries(env, 'ICSA', { limit: 2 }),
  ]);

  if (!out.totalNonfarmPayrolls && payrolls.status === 'fulfilled') {
    out.totalNonfarmPayrolls = {
      value: payrolls.value.value,
      numericValue: numberOrNull(payrolls.value.value),
      date: payrolls.value.date,
      previousValue: payrolls.value.previousValue,
      previousNumericValue: numberOrNull(payrolls.value.previousValue),
      previousDate: payrolls.value.previousDate,
      seriesId: 'PAYEMS',
      unit: 'thousands',
      source: 'FRED',
    };
  }

  if (!out.unemploymentRate && unemployment.status === 'fulfilled') {
    out.unemploymentRate = {
      value: unemployment.value.value,
      numericValue: numberOrNull(unemployment.value.value),
      date: unemployment.value.date,
      previousValue: unemployment.value.previousValue,
      previousNumericValue: numberOrNull(unemployment.value.previousValue),
      previousDate: unemployment.value.previousDate,
      seriesId: 'UNRATE',
      unit: 'percent',
      source: 'FRED',
    };
  }

  if (claims.status === 'fulfilled') {
    out.initialClaims = {
      value: claims.value.value,
      numericValue: numberOrNull(claims.value.value),
      date: claims.value.date,
      previousValue: claims.value.previousValue,
      previousNumericValue: numberOrNull(claims.value.previousValue),
      previousDate: claims.value.previousDate,
      seriesId: 'ICSA',
      unit: 'persons',
      source: 'FRED',
    };
  }

  if (out.totalNonfarmPayrolls?.numericValue != null && out.totalNonfarmPayrolls?.previousNumericValue != null) {
    out.payrollChangeThousands = {
      value: Math.round(out.totalNonfarmPayrolls.numericValue - out.totalNonfarmPayrolls.previousNumericValue),
      unit: 'thousands',
      source: out.totalNonfarmPayrolls.source,
    };
  }

  return out;
}

// -----------------------------------------------------------------------------
// Market — S&P 500/VIX from FRED + SPY quote from Finnhub if available
// -----------------------------------------------------------------------------
async function fetchMarket(env) {
  const [sp500, vix] = await Promise.allSettled([
    fetchFredSeries(env, 'SP500', { limit: 2 }),
    fetchFredSeries(env, 'VIXCLS', { limit: 2 }),
  ]);

  let spy = null;
  let spyError = null;
  const finnhubKey = getEnv(env, 'FINNHUB_API_KEY');

  if (finnhubKey) {
    try {
      spy = await fetchJson('https://finnhub.io/api/v1/quote?symbol=SPY', {
        headers: { 'X-Finnhub-Token': finnhubKey },
      });
    } catch (e) {
      spyError = e.message;
    }
  } else {
    spyError = 'FINNHUB_API_KEY not configured; SPY quote omitted.';
  }

  const sp500Value = sp500.status === 'fulfilled' ? numberOrNull(sp500.value.value) : null;
  const sp500Prev = sp500.status === 'fulfilled' ? numberOrNull(sp500.value.previousValue) : null;

  const out = {
    sp500: sp500.status === 'fulfilled' ? {
      value: sp500.value.value,
      numericValue: sp500Value,
      date: sp500.value.date,
      previousValue: sp500.value.previousValue,
      previousNumericValue: sp500Prev,
      previousDate: sp500.value.previousDate,
      seriesId: 'SP500',
      changePct: sp500Value != null && sp500Prev != null ? Number(((sp500Value / sp500Prev - 1) * 100).toFixed(2)) : null,
    } : null,
    vix: vix.status === 'fulfilled' ? {
      value: vix.value.value,
      numericValue: numberOrNull(vix.value.value),
      date: vix.value.date,
      previousValue: vix.value.previousValue,
      previousNumericValue: numberOrNull(vix.value.previousValue),
      previousDate: vix.value.previousDate,
      seriesId: 'VIXCLS',
    } : null,
    spy: spy ? {
      price: spy.c ?? null,
      change: spy.d ?? null,
      changePct: spy.dp ?? null,
      high: spy.h ?? null,
      low: spy.l ?? null,
      open: spy.o ?? null,
      previousClose: spy.pc ?? null,
    } : null,
    spyError,
  };

  // Backward-compatible aliases.
  out.spxLevel = out.sp500?.numericValue ? Math.round(out.sp500.numericValue) : null;
  out.spxChangePct = out.sp500?.changePct ?? null;

  return out;
}

// -----------------------------------------------------------------------------
// Treasury — Debt to the Penny, no API key
// -----------------------------------------------------------------------------
async function fetchTreasury() {
  const url = new URL('https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny');
  url.searchParams.set('fields', 'record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt');
  url.searchParams.set('sort', '-record_date');
  url.searchParams.set('page[size]', '1');

  const data = await fetchJson(url.toString());
  const row = data?.data?.[0] || null;

  if (!row) return null;

  return {
    recordDate: row.record_date,
    totalPublicDebtOutstanding: Number(row.tot_pub_debt_out_amt),
    debtHeldByPublic: Number(row.debt_held_public_amt),
    intragovernmentalHoldings: Number(row.intragov_hold_amt),
    raw: row,
  };
}

// -----------------------------------------------------------------------------
// FRED release calendar
// -----------------------------------------------------------------------------
async function fetchFredCalendar(env, requestUrl) {
  const key = requireEnv(env, 'FRED_API_KEY');

  const daysBack = clampNumber(requestUrl.searchParams.get('daysBack'), 0, 365, 7);
  const daysForward = clampNumber(requestUrl.searchParams.get('daysForward'), 1, 730, 120);
  const limit = clampNumber(requestUrl.searchParams.get('limit'), 1, 1000, 250);
  const q = (requestUrl.searchParams.get('q') || '').trim().toLowerCase();

  const start = requestUrl.searchParams.get('from') || dateDaysAgo(daysBack);
  const end = requestUrl.searchParams.get('to') || dateDaysForward(daysForward);

  const url = new URL('https://api.stlouisfed.org/fred/releases/dates');
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('realtime_start', start);
  url.searchParams.set('realtime_end', end);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order_by', 'release_date');
  url.searchParams.set('sort_order', 'asc');
  url.searchParams.set('include_release_dates_with_no_data', 'true');

  const data = await fetchJson(url.toString());
  let releaseDates = data?.release_dates || [];

  if (q) {
    releaseDates = releaseDates.filter(ev => String(ev.release_name || '').toLowerCase().includes(q));
  }

  const events = releaseDates.map(ev => ({
    id: ev.release_id,
    releaseId: ev.release_id,
    name: ev.release_name,
    releaseName: ev.release_name,
    release_name: ev.release_name,
    date: ev.date,
    detail: 'FRED release calendar',
    source: 'FRED',
  }));

  return {
    events,
    release_dates: releaseDates,
    meta: {
      from: start,
      to: end,
      count: events.length,
      sourceCount: data?.count ?? null,
      source: 'FRED releases/dates',
    },
  };
}

// -----------------------------------------------------------------------------
// Economic calendar for index.html FOMC and macro calendar panels
// -----------------------------------------------------------------------------
async function fetchEconomicCalendar(env, requestUrl) {
  const from = requestUrl.searchParams.get('from') || todayISO();
  const to = requestUrl.searchParams.get('to') || dateDaysForward(400);

  const items = [];

  // Pull FRED release dates where possible.
  try {
    const fredUrl = new URL('https://dummy.local/api/fred/calendar');
    fredUrl.searchParams.set('from', from);
    fredUrl.searchParams.set('to', to);
    fredUrl.searchParams.set('limit', '1000');
    const fred = await fetchFredCalendar(env, fredUrl);
    for (const ev of fred.events || []) {
      if (KEY_RELEASE_RE.test(ev.name || '')) {
        items.push({
          date: ev.date,
          event: ev.name,
          name: ev.name,
          detail: ev.detail || 'FRED release calendar',
          source: 'FRED',
        });
      }
    }
  } catch (e) {
    // Continue to fallback FOMC dates.
  }

  // Add FOMC fallback dates if within range.
  for (const f of FOMC_FALLBACK_2026) {
    if (f.date >= from && f.date <= to) {
      items.push({ ...f, name: f.event, detail: 'FOMC schedule fallback', source: 'fallback' });
    }
  }

  // Deduplicate by date + event.
  const seen = new Set();
  const deduped = items
    .filter(item => {
      const key = `${item.date}|${item.event}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return deduped;
}

// -----------------------------------------------------------------------------
// News — NewsAPI if configured; market query fallback if no category match
// -----------------------------------------------------------------------------
async function fetchMarketNews(env, requestUrl) {
  const key = getEnv(env, 'NEWSAPI_KEY');
  if (!key) {
    return {
      articles: [],
      error: 'NEWSAPI_KEY not configured.',
      lastUpdated: new Date().toISOString(),
    };
  }

  const category = requestUrl.searchParams.get('category') || 'business';
  const pageSize = clampNumber(requestUrl.searchParams.get('pageSize'), 1, 100, 30);

  let url;
  if (category === 'general' || category === 'market' || category === 'business') {
    url = new URL('https://newsapi.org/v2/top-headlines');
    url.searchParams.set('category', 'business');
    url.searchParams.set('country', 'us');
  } else {
    url = new URL('https://newsapi.org/v2/everything');
    url.searchParams.set('q', category);
    url.searchParams.set('language', 'en');
    url.searchParams.set('sortBy', 'publishedAt');
  }

  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('apiKey', key);

  const data = await fetchJson(url.toString());

  const articles = (data.articles || [])
    .filter(a => a.title && a.title !== '[Removed]')
    .map(a => normalizeArticle({
      title: a.title,
      url: a.url,
      source: a.source?.name,
      summary: a.description,
      image: a.urlToImage,
      publishedAt: a.publishedAt,
    }));

  return {
    articles,
    items: articles,
    lastUpdated: new Date().toISOString(),
  };
}

function normalizeArticle(article, extra = {}) {
  const publishedAt = article.publishedAt ??
    (article.datetime ? new Date(Number(article.datetime) * 1000).toISOString() : null);

  return compact({
    headline: article.headline ?? article.title,
    title: article.title ?? article.headline,
    summary: article.summary ?? article.description,
    description: article.description ?? article.summary,
    url: article.url,
    source: article.source?.name ?? article.source,
    sourceName: article.source?.name ?? article.source,
    image: article.image ?? article.urlToImage,
    urlToImage: article.urlToImage ?? article.image,
    datetime: article.datetime,
    publishedAt,
    ...extra,
  });
}

// -----------------------------------------------------------------------------
// Stock news — Finnhub company-news
// -----------------------------------------------------------------------------
async function fetchSingleStockNews(env, requestUrl) {
  const finnhubKey = getEnv(env, 'FINNHUB_API_KEY');
  if (!finnhubKey) {
    return { articles: [], items: [], error: 'FINNHUB_API_KEY not configured.' };
  }

  const symbol = (requestUrl.searchParams.get('symbol') || requestUrl.searchParams.get('ticker') || '').trim().toUpperCase();
  if (!symbol) throw new Error('Missing required query parameter: symbol');

  const from = requestUrl.searchParams.get('from') || dateDaysAgo(30);
  const to = requestUrl.searchParams.get('to') || todayISO();

  const url = new URL('https://finnhub.io/api/v1/company-news');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);

  const data = await fetchJson(url.toString(), {
    headers: { 'X-Finnhub-Token': finnhubKey },
  });

  const articles = (Array.isArray(data) ? data : [])
    .filter(a => a.headline || a.title)
    .map(a => normalizeArticle(a, { ticker: symbol, symbol }));

  return {
    articles,
    items: articles,
    ticker: symbol,
    symbol,
    from,
    to,
    lastUpdated: new Date().toISOString(),
  };
}

async function fetchStockNewsBatch(env, requestUrl) {
  const tickersParam = requestUrl.searchParams.get('tickers');
  const tickers = (tickersParam ? tickersParam.split(',') : DEFAULT_TICKERS)
    .map(t => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 40);

  const from = requestUrl.searchParams.get('from') || dateDaysAgo(14);
  const to = requestUrl.searchParams.get('to') || todayISO();

  const jobs = tickers.map(async ticker => {
    const u = new URL('https://dummy.local/api/stock-news');
    u.searchParams.set('symbol', ticker);
    u.searchParams.set('from', from);
    u.searchParams.set('to', to);
    const data = await fetchSingleStockNews(env, u);
    return { ticker, articles: data.articles || [] };
  });

  const settled = await Promise.allSettled(jobs);
  const results = {};
  const errors = {};

  for (const r of settled) {
    if (r.status === 'fulfilled') {
      results[r.value.ticker] = r.value.articles;
    } else {
      errors.unknown = r.reason?.message || String(r.reason);
    }
  }

  return {
    results,
    errors,
    meta: { tickers, from, to },
    lastUpdated: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Earnings — Finnhub earnings calendar
// -----------------------------------------------------------------------------
async function fetchEarnings(env, requestUrl) {
  const finnhubKey = getEnv(env, 'FINNHUB_API_KEY');
  if (!finnhubKey) {
    return { earningsCalendar: [], events: [], data: [], error: 'FINNHUB_API_KEY not configured.' };
  }

  const tickers = (requestUrl.searchParams.get('tickers') || '')
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(Boolean);

  const from = requestUrl.searchParams.get('from') || todayISO();
  const to = requestUrl.searchParams.get('to') || dateDaysForward(120);

  const url = new URL('https://finnhub.io/api/v1/calendar/earnings');
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);

  const data = await fetchJson(url.toString(), {
    headers: { 'X-Finnhub-Token': finnhubKey },
  });

  let rows = data?.earningsCalendar || [];
  if (tickers.length) {
    const set = new Set(tickers);
    rows = rows.filter(e => set.has(String(e.symbol || '').toUpperCase()));
  }

  const events = rows.map(e => compact({
    symbol: e.symbol,
    ticker: e.symbol,
    date: e.date,
    hour: e.hour,
    year: e.year,
    quarter: e.quarter ? `Q${e.quarter}` : undefined,
    fiscalQuarter: e.quarter ? `Q${e.quarter}` : undefined,
    epsEstimate: e.epsEstimate,
    epsActual: e.epsActual,
    revenueEstimate: e.revenueEstimate,
    revenueActual: e.revenueActual,
    period: e.quarter ? `Q${e.quarter}` : 'Earnings',
  }));

  return {
    earningsCalendar: events,
    events,
    data: events,
    meta: { from, to, tickers },
    lastUpdated: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// BEA GDP — optional direct BEA support
// -----------------------------------------------------------------------------
async function fetchBeaGdp(env) {
  const key = getEnv(env, 'BEA_API_KEY');
  if (!key) return { error: 'BEA_API_KEY not configured.' };

  const url = new URL('https://apps.bea.gov/api/data');
  url.searchParams.set('UserID', key);
  url.searchParams.set('method', 'GetData');
  url.searchParams.set('datasetname', 'NIPA');
  url.searchParams.set('TableName', 'T10101');
  url.searchParams.set('Frequency', 'Q');
  url.searchParams.set('Year', 'X');
  url.searchParams.set('ResultFormat', 'JSON');

  const data = await fetchJson(url.toString());
  const rows = data?.BEAAPI?.Results?.Data || [];

  // Line 1 is GDP, Chained dollars is often line 1 depending table; return recent rows without overfitting.
  const recent = rows.slice(-8);
  return {
    data: recent,
    lastUpdated: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Census-sourced indicators via FRED proxy series
// -----------------------------------------------------------------------------
async function fetchCensusIndicatorsViaFred(env) {
  const ids = {
    retailSales: 'RSAFS',
    housingStarts: 'HOUST',
    durableGoodsNewOrders: 'NEWORDER',
    newHomeSales: 'HSN1F',
  };

  const jobs = Object.entries(ids).map(async ([key, seriesId]) => {
    const latest = await fetchFredSeries(env, seriesId, { limit: 2 });
    return { key, seriesId, ...latest };
  });

  const settled = await Promise.allSettled(jobs);
  const out = {};
  const errors = {};

  for (const item of settled) {
    if (item.status === 'fulfilled') {
      out[item.value.key] = {
        value: item.value.value,
        numericValue: numberOrNull(item.value.value),
        date: item.value.date,
        previousValue: item.value.previousValue,
        previousNumericValue: numberOrNull(item.value.previousValue),
        previousDate: item.value.previousDate,
        seriesId: item.value.seriesId,
        source: 'FRED/Census series',
      };
    } else {
      errors.general = item.reason?.message || String(item.reason);
    }
  }

  return {
    ...out,
    errors,
    lastUpdated: new Date().toISOString(),
  };
}
