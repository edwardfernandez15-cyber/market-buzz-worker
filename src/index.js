/**
 * market-buzz-worker — Cloudflare Worker
 * Proxies FRED and Finnhub APIs to avoid browser CORS restrictions.
 *
 * Endpoint paths match what index.html calls:
 *   GET /api/news?category=general          — Finnhub market news
 *   GET /api/stock-news?symbol=AAPL&from=…&to=…  — Finnhub company news
 *   GET /api/fred?series_id=FEDFUNDS&limit=1&sort_order=desc&units=pc1
 *
 * Required secrets (set in CF Workers → Settings → Variables):
 *   FINNHUB_API_KEY
 *   FRED_API_KEY
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── CORS preflight ───────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204);
    }

    // ── Route dispatcher ─────────────────────────────────────────────────────
    if (path === '/api/news') {
      return handleMarketNews(url, env);
    }
    if (path === '/api/stock-news') {
      return handleStockNews(url, env);
    }
    if (path === '/api/fred') {
      return handleFred(url, env);
    }

    return jsonError('Not found', 404);
  },
};

// ────────────────────────────────────────────────────────────────────────────
//  /api/news?category=general
// ────────────────────────────────────────────────────────────────────────────
async function handleMarketNews(url, env) {
  if (!env.FINNHUB_API_KEY) {
    return jsonError('FINNHUB_API_KEY is not set', 500);
  }

  const category = url.searchParams.get('category') || 'general';
  const minId    = url.searchParams.get('minId')    || '0';

  const upstream = `https://finnhub.io/api/v1/news`
    + `?category=${encodeURIComponent(category)}`
    + `&minId=${minId}`
    + `&token=${env.FINNHUB_API_KEY}`;

  try {
    const resp = await fetch(upstream, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`Finnhub error: ${resp.status} ${resp.statusText}`, resp.status);
    const data = await resp.json();
    return jsonOk(data, 300); // 5-min cache
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  /api/stock-news?symbol=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD
// ────────────────────────────────────────────────────────────────────────────
async function handleStockNews(url, env) {
  if (!env.FINNHUB_API_KEY) {
    return jsonError('FINNHUB_API_KEY is not set', 500);
  }

  const symbol = url.searchParams.get('symbol');
  if (!symbol) return jsonError('Missing required param: symbol', 400);

  const toDate   = url.searchParams.get('to')   || new Date().toISOString().slice(0, 10);
  const fromDate = url.searchParams.get('from') || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const upstream = `https://finnhub.io/api/v1/company-news`
    + `?symbol=${encodeURIComponent(symbol)}`
    + `&from=${fromDate}`
    + `&to=${toDate}`
    + `&token=${env.FINNHUB_API_KEY}`;

  try {
    const resp = await fetch(upstream, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`Finnhub error: ${resp.status} ${resp.statusText}`, resp.status);
    const data = await resp.json();
    return jsonOk(data, 300); // 5-min cache
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  /api/fred?series_id=FEDFUNDS&limit=1&sort_order=desc[&units=pc1]
//            [&observation_start=YYYY-MM-DD][&observation_end=YYYY-MM-DD]
// ────────────────────────────────────────────────────────────────────────────
async function handleFred(url, env) {
  if (!env.FRED_API_KEY) {
    return jsonError('FRED_API_KEY is not set', 500);
  }

  const seriesId  = url.searchParams.get('series_id');
  if (!seriesId) return jsonError('Missing required param: series_id', 400);

  const limit     = url.searchParams.get('limit')      || '1';
  const sortOrder = url.searchParams.get('sort_order') || 'desc';
  const units     = url.searchParams.get('units')      || '';
  const obsStart  = url.searchParams.get('observation_start') || '';
  const obsEnd    = url.searchParams.get('observation_end')   || '';

  let fredUrl = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${encodeURIComponent(seriesId)}`
    + `&api_key=${env.FRED_API_KEY}`
    + `&file_type=json`
    + `&sort_order=${sortOrder}`
    + `&limit=${limit}`;

  if (units)    fredUrl += `&units=${encodeURIComponent(units)}`;
  if (obsStart) fredUrl += `&observation_start=${obsStart}`;
  if (obsEnd)   fredUrl += `&observation_end=${obsEnd}`;

  try {
    const resp = await fetch(fredUrl, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
    if (!resp.ok) return jsonError(`FRED error: ${resp.status} ${resp.statusText}`, resp.status);
    const data = await resp.json();
    return jsonOk(data, 3600); // 1-hour cache — macro data doesn't move minute-to-minute
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────────────
function jsonOk(data, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  });
}

function jsonError(msg, status = 500) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
