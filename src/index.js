/**
 * MACRO OUTLOOK — Cloudflare Worker
 * ─────────────────────────────────────────────────────────────────
 * Proxies all API calls so secret keys stay server-side.
 *
 * DEPLOY STEPS:
 *   1. Go to dash.cloudflare.com → Workers & Pages → Create
 *   2. Paste this file, click Save & Deploy
 *   3. In the Worker Settings → Variables & Secrets, bind:
 *       BEA_API_KEY, BLS_API_KEY, CENSUS_API_KEY, EIA_API_KEY,
 *       FINNHUB_API_KEY, FRED_API_KEY, NEWSAPI_KEY, TIPRANKS_API_KEY
 *   4. Copy the worker URL (e.g. https://macro-data.yourname.workers.dev)
 *   5. Paste it into WORKER_URL in usa_macro_outlook_trend_analysis.html
 *
 * ENDPOINTS:
 *   GET /api/all     — all categories in one call (used by the HTML)
 *   GET /api/energy  — EIA + FRED energy prices & storage
 *   GET /api/macro   — FRED macroeconomic indicators
 *   GET /api/market  — Finnhub equities & volatility
 *   GET /api/labor   — BLS payrolls & claims
 *   GET /api/news    — NewsAPI top business headlines
 */

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=900',   // 15 min CDN cache
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' }
      });
    }

    const path = url.pathname;

    try {
      let body;

      if (path === '/api/all' || path === '/api/data') {
        const [en, mac, mkt, news] = await Promise.allSettled([
          fetchEnergy(env),
          fetchMacro(env),
          fetchMarket(env),
          fetchNews(env),
        ]);
        body = {
          energy:      en.status   === 'fulfilled' ? en.value   : {},
          macro:       mac.status  === 'fulfilled' ? mac.value  : {},
          market:      mkt.status  === 'fulfilled' ? mkt.value  : {},
          news:        news.status === 'fulfilled' ? news.value : [],
          lastUpdated: new Date().toISOString(),
        };
      } else if (path === '/api/energy') {
        body = await fetchEnergy(env);
      } else if (path === '/api/macro') {
        body = await fetchMacro(env);
      } else if (path === '/api/market') {
        body = await fetchMarket(env);
      } else if (path === '/api/labor') {
        body = await fetchLabor(env);
      } else if (path === '/api/news') {
        body = await fetchNews(env);
      } else {
        return new Response(JSON.stringify({ error: 'Not found', routes: ['/api/all', '/api/energy', '/api/macro', '/api/market', '/api/labor', '/api/news'] }), { status: 404, headers: cors });
      }

      return new Response(JSON.stringify(body), { headers: cors });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
    }
  }
};

// ─────────────────────────────────────────────────────────────────
// ENERGY  (FRED for spot prices, EIA for gas storage)
// ─────────────────────────────────────────────────────────────────
async function fetchEnergy(env) {
  const FRED = env.FRED_API_KEY;
  const EIA  = env.EIA_API_KEY;

  // FRED series: Brent (DCOILBRENTEU), WTI (DCOILWTICO), Henry Hub (DHHNGSP)
  const fredBase = `https://api.stlouisfed.org/fred/series/observations?api_key=${FRED}&file_type=json&sort_order=desc&limit=3`;
  const [brentR, wtiR, hhR, storageR] = await Promise.allSettled([
    fetch(`${fredBase}&series_id=DCOILBRENTEU`).then(r => r.json()),
    fetch(`${fredBase}&series_id=DCOILWTICO`).then(r => r.json()),
    fetch(`${fredBase}&series_id=DHHNGSP`).then(r => r.json()),
    // EIA weekly natural gas storage (Lower 48, Bcf)
    fetch(`https://api.eia.gov/v2/natural-gas/stor/wkly/data/?api_key=${EIA}&facets[duoarea][]=NUS&facets[process][]=SAB&frequency=weekly&sort[0][column]=period&sort[0][direction]=desc&length=6`).then(r => r.json()),
  ]);

  function latestFred(res) {
    if (res.status !== 'fulfilled') return null;
    const obs = (res.value?.observations || []).filter(o => o.value !== '.' && o.value !== 'NA');
    return obs[0]?.value ?? null;
  }

  // Storage: show current Bcf + week-over-week change
  let storageStr = null;
  if (storageR.status === 'fulfilled') {
    const rows = storageR.value?.response?.data || [];
    if (rows.length >= 2) {
      const cur  = parseFloat(rows[0]?.value);
      const prev = parseFloat(rows[1]?.value);
      const wow  = Math.round(cur - prev);
      storageStr = `${(cur / 1000).toFixed(2)} Tcf (${wow >= 0 ? '+' : ''}${wow} Bcf WoW)`;
    } else if (rows.length === 1) {
      storageStr = `${(parseFloat(rows[0].value) / 1000).toFixed(2)} Tcf`;
    }
  }

  return {
    brent:    latestFred(brentR),
    wti:      latestFred(wtiR),
    henryHub: latestFred(hhR),
    storage:  storageStr,
  };
}

// ─────────────────────────────────────────────────────────────────
// MACRO  (FRED)
// ─────────────────────────────────────────────────────────────────
async function fetchMacro(env) {
  const KEY  = env.FRED_API_KEY;
  const base = `https://api.stlouisfed.org/fred/series/observations?api_key=${KEY}&file_type=json&sort_order=desc`;

  // series_id → output key
  const series = {
    UNRATE:      'unemployment',   // Unemployment rate, %
    DGS10:       'tenYear',        // 10-yr Treasury yield
    UMCSENT:     'michigan',       // U of Michigan Consumer Sentiment
    MORTGAGE30US:'mortgage',       // 30-yr fixed mortgage rate
    PSAVERT:     'savingRate',     // Personal saving rate
    PCEPILFE:    'corePCE',        // Core PCE Price Index (use units=pc1 for YoY%)
    ICSA:        'claims',         // Initial jobless claims (weekly)
    PAYEMS:      'payrollsLevel',  // Total nonfarm payroll, thousands
    FEDFUNDS:    'fedFunds',       // Federal funds effective rate
  };

  const jobs = Object.entries(series).map(([sid, key]) => {
    // For Core PCE request YoY % change transformation
    const extra = sid === 'PCEPILFE' ? '&units=pc1' : '';
    return fetch(`${base}&series_id=${sid}&limit=2${extra}`)
      .then(r => r.json())
      .then(d => {
        const obs = (d.observations || []).filter(o => o.value !== '.' && o.value !== 'NA');
        return { key, latest: obs[0]?.value ?? null, prev: obs[1]?.value ?? null, date: obs[0]?.date ?? null };
      });
  });

  const results = await Promise.allSettled(jobs);
  const data = {};

  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value.latest) continue;
    const { key, latest, prev } = r.value;
    data[key] = latest;
    // Monthly payroll change (thousands)
    if (key === 'payrollsLevel' && prev) {
      data.payrollChg = Math.round(parseFloat(latest) - parseFloat(prev));
    }
  }

  // BEA: GDP current quarter (use FRED proxy series GDPC1 for real GDP growth)
  try {
    const gdpRes = await fetch(`${base}&series_id=GDPC1&limit=2`).then(r => r.json());
    const obs = (gdpRes.observations || []).filter(o => o.value !== '.' && o.value !== 'NA');
    if (obs.length >= 2) {
      const cur  = parseFloat(obs[0].value);
      const prev = parseFloat(obs[1].value);
      // Annualised QoQ %
      data.gdpQoQ = ((cur / prev - 1) * 400).toFixed(1);
    }
  } catch(_) {}

  return data;
}

// ─────────────────────────────────────────────────────────────────
// MARKET  (Finnhub)
// ─────────────────────────────────────────────────────────────────
async function fetchMarket(env) {
  const KEY = env.FINNHUB_API_KEY;
  const hdr = { 'X-Finnhub-Token': KEY };

  const [spyR, vixR] = await Promise.allSettled([
    fetch('https://finnhub.io/api/v1/quote?symbol=SPY',  { headers: hdr }).then(r => r.json()),
    fetch('https://finnhub.io/api/v1/quote?symbol=UVXY', { headers: hdr }).then(r => r.json()),
  ]);

  const spy = spyR.status === 'fulfilled' ? spyR.value : null;
  const vix = vixR.status === 'fulfilled' ? vixR.value : null;

  // SPY * ~10.01 ≈ S&P 500 level (approximate)
  const spxLevel     = spy?.c  ? Math.round(spy.c * 10.01)  : null;
  const spxChangePct = spy?.dp ? parseFloat(spy.dp.toFixed(2)) : null;

  return {
    spyPrice:     spy?.c    ?? null,
    spxLevel,
    spxChangePct,
    spxHigh:      spy?.h    ? Math.round(spy.h * 10.01) : null,
    spxLow:       spy?.l    ? Math.round(spy.l * 10.01) : null,
    vix:          vix?.c    ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────
// LABOR  (BLS API v2) — standalone endpoint
// ─────────────────────────────────────────────────────────────────
async function fetchLabor(env) {
  const KEY = env.BLS_API_KEY;
  const payload = {
    seriesid:        ['CES0000000001', 'LNS14000000', 'ICSA'],
    registrationkey: KEY,
    latest:          true,
  };

  try {
    const res = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    }).then(r => r.json());

    const out = {};
    for (const s of (res?.Results?.series || [])) {
      const val = s.data?.[0]?.value;
      if (s.seriesID === 'CES0000000001') out.totalNonfarm = val;
      if (s.seriesID === 'LNS14000000')  out.unemployment = val;
      if (s.seriesID === 'ICSA')         out.initialClaims = val;
    }
    return out;
  } catch(e) {
    return { error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────
// NEWS  (NewsAPI)
// ─────────────────────────────────────────────────────────────────
async function fetchNews(env) {
  const KEY = env.NEWSAPI_KEY;
  const url = `https://newsapi.org/v2/top-headlines?category=business&country=us&pageSize=6&apiKey=${KEY}`;

  try {
    const res = await fetch(url).then(r => r.json());
    return (res.articles || [])
      .filter(a => a.title && a.title !== '[Removed]')
      .slice(0, 5)
      .map(a => ({
        title:       a.title,
        url:         a.url,
        source:      a.source?.name,
        publishedAt: a.publishedAt,
      }));
  } catch(e) {
    return [];
  }
}
