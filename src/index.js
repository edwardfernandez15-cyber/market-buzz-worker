/**
 * market-buzz-worker — Cloudflare Worker
 * Proxies FRED and Finnhub APIs to avoid browser CORS restrictions.
 * Deployed to: www.financeninja.work/api/*
 *
 * Endpoints:
 *   GET /api/news?category=general          — Finnhub market news
 *   GET /api/stock-news?symbol=AAPL&from=…&to=…  — Finnhub company news
 *   GET /api/fred?series_id=FEDFUNDS&limit=1&sort_order=desc[&units=pc1]
 *   GET /api/ecocal?from=YYYY-MM-DD&to=YYYY-MM-DD — Finnhub economic calendar
 *   GET /api/earnings?tickers=ABBV,GOOGL&from=…&to=… — Finnhub earnings calendar (filtered)
 *   GET /api/all    — Aggregated macro + energy + market + news for macro dashboard
 *
 * Required secrets (Workers → Settings → Variables):
 *   FINNHUB_API_KEY
 *   FRED_API_KEY
 */

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── CORS preflight ─────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204);
    }

    // ── Route dispatcher ───────────────────────────────────────────────────
    if (path === '/api/news')              return handleMarketNews(url, env);
    if (path === '/api/stock-news')        return handleStockNews(url, env);
    if (path === '/api/fred')              return handleFred(url, env);
    if (path === '/api/ecocal')            return handleEcoCal(url, env);
    if (path === '/api/earnings')          return handleEarnings(url, env);
    if (path === '/api/all')               return handleAll(url, env);
    if (path === '/api/sector-etfs/quote') return handleSectorQuote(url, env);
    if (path === '/api/sector-etfs/candle')return handleSectorCandle(url, env);

    return jsonError('Not found', 404);
  },
};

// ────────────────────────────────────────────────────────────────────────────
//  /api/news?category=general
// ────────────────────────────────────────────────────────────────────────────
async function handleMarketNews(url, env) {
  if (!env.FINNHUB_API_KEY) return jsonError('FINNHUB_API_KEY is not set', 500);

  const category = url.searchParams.get('category') || 'general';
  const minId    = url.searchParams.get('minId')    || '0';

  const upstream =
    `https://finnhub.io/api/v1/news` +
    `?category=${encodeURIComponent(category)}` +
    `&minId=${minId}` +
    `&token=${env.FINNHUB_API_KEY}`;

  try {
    const resp = await fetch(upstream, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`Finnhub error: ${resp.status} ${resp.statusText}`, resp.status);
    return jsonOk(await resp.json(), 300); // 5-min cache
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  /api/stock-news?symbol=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD
// ────────────────────────────────────────────────────────────────────────────
async function handleStockNews(url, env) {
  if (!env.FINNHUB_API_KEY) return jsonError('FINNHUB_API_KEY is not set', 500);

  const symbol = url.searchParams.get('symbol');
  if (!symbol) return jsonError('Missing required param: symbol', 400);

  const toDate   = url.searchParams.get('to')   || new Date().toISOString().slice(0, 10);
  const fromDate = url.searchParams.get('from') || new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const upstream =
    `https://finnhub.io/api/v1/company-news` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&from=${fromDate}&to=${toDate}` +
    `&token=${env.FINNHUB_API_KEY}`;

  try {
    const resp = await fetch(upstream, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`Finnhub error: ${resp.status} ${resp.statusText}`, resp.status);
    return jsonOk(await resp.json(), 300);
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  /api/fred?series_id=FEDFUNDS&limit=1&sort_order=desc[&units=pc1]
//            [&observation_start=YYYY-MM-DD][&observation_end=YYYY-MM-DD]
// ────────────────────────────────────────────────────────────────────────────
async function handleFred(url, env) {
  if (!env.FRED_API_KEY) return jsonError('FRED_API_KEY is not set', 500);

  const seriesId = url.searchParams.get('series_id');
  if (!seriesId) return jsonError('Missing required param: series_id', 400);

  const limit     = url.searchParams.get('limit')      || '1';
  const sortOrder = url.searchParams.get('sort_order') || 'desc';
  const units     = url.searchParams.get('units')      || '';
  const obsStart  = url.searchParams.get('observation_start') || '';
  const obsEnd    = url.searchParams.get('observation_end')   || '';

  let fredUrl =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${env.FRED_API_KEY}` +
    `&file_type=json` +
    `&sort_order=${sortOrder}` +
    `&limit=${limit}`;
  if (units)    fredUrl += `&units=${encodeURIComponent(units)}`;
  if (obsStart) fredUrl += `&observation_start=${obsStart}`;
  if (obsEnd)   fredUrl += `&observation_end=${obsEnd}`;

  try {
    const resp = await fetch(fredUrl, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`FRED error: ${resp.status} ${resp.statusText}`, resp.status);
    return jsonOk(await resp.json(), 3600); // 1-hr cache — macro data moves slowly
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  /api/ecocal?from=YYYY-MM-DD&to=YYYY-MM-DD
// ────────────────────────────────────────────────────────────────────────────
async function handleEcoCal(url, env) {
  if (!env.FINNHUB_API_KEY) return jsonError('FINNHUB_API_KEY is not set', 500);

  const now   = new Date();
  const sixMo = new Date(now.getTime() + 180 * 86_400_000);
  const from  = url.searchParams.get('from') || now.toISOString().slice(0, 10);
  const to    = url.searchParams.get('to')   || sixMo.toISOString().slice(0, 10);

  const upstream =
    `https://finnhub.io/api/v1/calendar/economic` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&token=${env.FINNHUB_API_KEY}`;

  try {
    const resp = await fetch(upstream, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`Finnhub error: ${resp.status} ${resp.statusText}`, resp.status);
    const data   = await resp.json();
    const events = Array.isArray(data) ? data : (data.economicCalendar || []);
    return jsonOk(events, 3600);
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  /api/earnings?tickers=ABBV,GOOGL,...&from=YYYY-MM-DD&to=YYYY-MM-DD
// ────────────────────────────────────────────────────────────────────────────
async function handleEarnings(url, env) {
  if (!env.FINNHUB_API_KEY) return jsonError('FINNHUB_API_KEY is not set', 500);

  const today   = new Date().toISOString().slice(0, 10);
  const plus120 = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  const from    = url.searchParams.get('from') || today;
  const to      = url.searchParams.get('to')   || plus120;

  // Optional: filter to specific portfolio tickers
  const rawTickers = url.searchParams.get('tickers') || '';
  const tickerSet  = new Set(
    rawTickers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
  );

  const upstream =
    `https://finnhub.io/api/v1/calendar/earnings` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&token=${env.FINNHUB_API_KEY}`;

  try {
    const resp = await fetch(upstream, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`Finnhub error: ${resp.status} ${resp.statusText}`, resp.status);

    const data     = await resp.json();
    const all      = Array.isArray(data) ? data : (data.earningsCalendar || []);
    const filtered = tickerSet.size > 0
      ? all.filter(e => tickerSet.has((e.symbol || '').toUpperCase()))
      : all;

    // Normalise shape
    const normalised = filtered.map(e => ({
      symbol:          e.symbol          || '',
      date:            e.date            || '',
      hour:            e.hour            || '',
      epsEstimate:     e.epsEstimate     ?? null,
      revenueEstimate: e.revenueEstimate ?? null,
      fiscalQuarter:   e.quarter || e.fiscalQuarter || '',
      period:          e.period  || '',
    }));

    return jsonOk({ earningsCalendar: normalised }, 900); // 15-min cache
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  /api/all — macro dashboard aggregator
//  Returns combined energy + macro + market + news payload.
//  Shape matches updatePage() in usa_macro_outlook_trend_analysis.html.
// ────────────────────────────────────────────────────────────────────────────
async function handleAll(url, env) {
  const hasFred    = Boolean(env.FRED_API_KEY);
  const hasFinnhub = Boolean(env.FINNHUB_API_KEY);

  // Fire all upstream calls in parallel
  const [
    brentRes, wtiRes, hhRes,
    unrateRes, corePceRes, michiganRes,
    mortgageRes, payemsRes, icsaRes,
    gdpRes, sp500Res, newsRes,
  ] = await Promise.allSettled([
    hasFred    ? fredLatest('DCOILBRENTEU',    env, 1)         : noop(),
    hasFred    ? fredLatest('DCOILWTICO',      env, 1)         : noop(),
    hasFred    ? fredLatest('DHHNGSP',         env, 1)         : noop(),
    hasFred    ? fredLatest('UNRATE',          env, 1)         : noop(),
    hasFred    ? fredLatest('PCEPILFE',        env, 1, 'pc1')  : noop(),
    hasFred    ? fredLatest('UMCSENT',         env, 1)         : noop(),
    hasFred    ? fredLatest('MORTGAGE30US',    env, 1)         : noop(),
    hasFred    ? fredLatest('PAYEMS',          env, 2)         : noop(),  // level; diff → MoM chg
    hasFred    ? fredLatest('ICSA',            env, 1)         : noop(),
    hasFred    ? fredLatest('A191RL1Q225SBEA', env, 1)         : noop(),
    hasFred    ? fredLatest('SP500',           env, 2)         : noop(),  // level; diff → chg%
    hasFinnhub ? fetchFinnhubNews('general',   env)            : noop(),
  ]);

  const get = r => (r.status === 'fulfilled' ? r.value : null);

  // Scalar helpers
  const numV = obs => {
    const v = Array.isArray(obs) ? obs[0]?.value : obs?.value;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const strV = obs => {
    const v = Array.isArray(obs) ? obs[0]?.value : obs?.value;
    return v && v !== '.' ? v : null;
  };

  // Payroll MoM change (PAYEMS is job-level in thousands)
  let payrollChg = null;
  const payArr = get(payemsRes);
  if (Array.isArray(payArr) && payArr.length >= 2) {
    const a = parseFloat(payArr[0].value), b = parseFloat(payArr[1].value);
    if (Number.isFinite(a) && Number.isFinite(b)) payrollChg = a - b;
  }

  // S&P 500 level + day % change
  let spxLevel = null, spxChangePct = null;
  const spArr = get(sp500Res);
  if (Array.isArray(spArr) && spArr.length >= 2) {
    const l = parseFloat(spArr[0].value), p = parseFloat(spArr[1].value);
    if (Number.isFinite(l)) spxLevel = l;
    if (Number.isFinite(l) && Number.isFinite(p) && p > 0)
      spxChangePct = ((l - p) / p) * 100;
  } else if (Array.isArray(spArr) && spArr.length === 1) {
    spxLevel = parseFloat(spArr[0].value);
  }

  const news = formatNewsItems(get(newsRes));

  return jsonOk({
    energy: {
      brent:    numV(get(brentRes)),
      wti:      numV(get(wtiRes)),
      henryHub: numV(get(hhRes)),
    },
    macro: {
      unemployment: strV(get(unrateRes)),
      corePCE:      strV(get(corePceRes)),
      michigan:     numV(get(michiganRes)),
      mortgage:     numV(get(mortgageRes)),
      payrollChg,
      claims:       numV(get(icsaRes)),
      gdpNow:       numV(get(gdpRes)),
    },
    labor: {
      payrollChangeThousands: payrollChg,
      unemploymentRate:       strV(get(unrateRes)),
    },
    market: { spxLevel, spxChangePct },
    news,
    lastUpdated: new Date().toISOString(),
  }, 900); // 15-min cache
}

// ── FRED sub-helpers ─────────────────────────────────────────────────────────
/**
 * Fetch the latest N observations for a FRED series (sorted desc, newest first).
 * Returns:  single obs object (limit=1) | array of obs objects (limit>1)
 */
async function fredLatest(seriesId, env, limit = 1, units = '') {
  const unitsParam = units ? `&units=${encodeURIComponent(units)}` : '';
  const fredUrl =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${env.FRED_API_KEY}` +
    `&file_type=json&sort_order=desc` +
    `&limit=${limit}` +
    unitsParam;
  const resp = await fetch(fredUrl, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
  if (!resp.ok) throw new Error(`FRED ${seriesId}: HTTP ${resp.status}`);
  const data  = await resp.json();
  const valid = (data.observations || []).filter(o => o.value && o.value !== '.');
  return limit === 1 ? (valid[0] ?? null) : valid;
}

async function fetchFinnhubNews(category, env) {
  const upstream = `https://finnhub.io/api/v1/news?category=${encodeURIComponent(category)}&token=${env.FINNHUB_API_KEY}`;
  const resp = await fetch(upstream, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
  if (!resp.ok) throw new Error(`Finnhub news: HTTP ${resp.status}`);
  return resp.json();
}

function formatNewsItems(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : (raw.articles || raw.items || raw.news || []);
  return arr.slice(0, 10).map(a => ({
    title:       a.headline || a.title  || '(no title)',
    url:         a.url      || '#',
    source:      typeof a.source === 'string' ? a.source : (a.source?.name || ''),
    publishedAt: a.datetime
      ? new Date(a.datetime * 1000).toISOString()
      : (a.publishedAt || a.date || new Date().toISOString()),
  }));
}

function noop() { return Promise.resolve(null); }

// ────────────────────────────────────────────────────────────────────────────
//  /api/sector-etfs/quote?symbol=XLK   — Finnhub real-time quote for one ETF
// ────────────────────────────────────────────────────────────────────────────
async function handleSectorQuote(url, env) {
  if (!env.FINNHUB_API_KEY) return jsonError('FINNHUB_API_KEY not set', 500);
  const symbol = url.searchParams.get('symbol');
  if (!symbol) return jsonError('Missing symbol', 400);

  const upstream = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${env.FINNHUB_API_KEY}`;
  try {
    const resp = await fetch(upstream, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`Finnhub ${resp.status}`, resp.status);
    const d = await resp.json();
    // c=current, pc=prev close, dp=day%, h=high, l=low, o=open
    return jsonOk({ c: d.c, pc: d.pc, dp: d.dp, h: d.h, l: d.l, o: d.o }, 300);
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  /api/sector-etfs/candle?symbol=XLK&from=<unix>&to=<unix>
//  Returns daily OHLCV candles — used to compute MTD % from month-open price
// ────────────────────────────────────────────────────────────────────────────
async function handleSectorCandle(url, env) {
  if (!env.FINNHUB_API_KEY) return jsonError('FINNHUB_API_KEY not set', 500);
  const symbol = url.searchParams.get('symbol');
  const from   = url.searchParams.get('from');
  const to     = url.searchParams.get('to');
  if (!symbol || !from || !to) return jsonError('Missing symbol, from, or to', 400);

  const upstream =
    `https://finnhub.io/api/v1/stock/candle` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=D&from=${from}&to=${to}` +
    `&token=${env.FINNHUB_API_KEY}`;
  try {
    const resp = await fetch(upstream, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`Finnhub ${resp.status}`, resp.status);
    const d = await resp.json();
    if (d.s !== 'ok') return jsonError('No candle data', 404);
    return jsonOk({ o: d.o, c: d.c, h: d.h, l: d.l, t: d.t }, 900);
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ── Response helpers ─────────────────────────────────────────────────────────
function jsonOk(data, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers':'Content-Type',
      'Cache-Control':               `public, max-age=${maxAge}`,
    },
  });
}

function jsonError(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
