/**
 * GET /api/all
 * Cloudflare Pages Function — aggregates macro + energy + market + news into one response.
 * Used by usa_macro_outlook_trend_analysis.html's fetchLive() call.
 *
 * Requires secrets: FINNHUB_API_KEY  FRED_API_KEY
 *
 * Response shape (matches updatePage() in the macro page):
 * {
 *   energy:  { brent, wti, henryHub }
 *   macro:   { unemployment, corePCE, michigan, mortgage, payrollChg, claims, gdpNow }
 *   labor:   { payrollChangeThousands, unemploymentRate }
 *   market:  { spxLevel, spxChangePct }
 *   news:    [{ title, url, source, publishedAt }]
 *   lastUpdated: ISO string
 * }
 */
export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') {
    return corsResponse();
  }

  // Both keys are needed; if either is missing return a partial response
  const hasFred    = Boolean(env.FRED_API_KEY);
  const hasFinnhub = Boolean(env.FINNHUB_API_KEY);

  if (!hasFred && !hasFinnhub) {
    return jsonError('FRED_API_KEY and FINNHUB_API_KEY secrets are not set.', 500);
  }

  // ── Fire all fetches in parallel ─────────────────────────────────────────
  const [
    brentRes, wtiRes, hhRes,
    unrateRes, corePceRes, michiganRes,
    mortgageRes, payemsRes, icsaRes,
    gdpRes, sp500Res, newsRes,
  ] = await Promise.allSettled([
    hasFred ? fredObs('DCOILBRENTEU',     env, 1)        : skip(),  // Brent crude $/barrel
    hasFred ? fredObs('DCOILWTICO',       env, 1)        : skip(),  // WTI crude $/barrel
    hasFred ? fredObs('DHHNGSP',          env, 1)        : skip(),  // Henry Hub $/MMBtu
    hasFred ? fredObs('UNRATE',           env, 1)        : skip(),  // Unemployment %
    hasFred ? fredObs('PCEPILFE',         env, 1, 'pc1'): skip(),  // Core PCE YoY %
    hasFred ? fredObs('UMCSENT',          env, 1)        : skip(),  // Michigan sentiment
    hasFred ? fredObs('MORTGAGE30US',     env, 1)        : skip(),  // 30-yr mortgage %
    hasFred ? fredObs('PAYEMS',           env, 2)        : skip(),  // Payroll (last 2 → delta)
    hasFred ? fredObs('ICSA',             env, 1)        : skip(),  // Initial jobless claims
    hasFred ? fredObs('A191RL1Q225SBEA', env, 1)        : skip(),  // Real GDP growth %
    hasFred ? fredObs('SP500',            env, 2)        : skip(),  // S&P 500 level (last 2 → chg)
    hasFinnhub ? finnhubNews('general',   env)           : skip(),  // Market headlines
  ]);

  const get = r => (r.status === 'fulfilled' ? r.value : null);

  // Scalar values
  const brent    = numFirst(get(brentRes));
  const wti      = numFirst(get(wtiRes));
  const hh       = numFirst(get(hhRes));
  const unrate   = strFirst(get(unrateRes));
  const corePce  = strFirst(get(corePceRes));
  const michigan = numFirst(get(michiganRes));
  const mortgage = numFirst(get(mortgageRes));
  const icsa     = numFirst(get(icsaRes));
  const gdp      = numFirst(get(gdpRes));

  // Payroll MoM change — PAYEMS is a level in thousands of persons
  let payrollChg = null;
  const payArr = get(payemsRes);
  if (Array.isArray(payArr) && payArr.length >= 2) {
    const a = parseFloat(payArr[0].value), b = parseFloat(payArr[1].value);
    if (Number.isFinite(a) && Number.isFinite(b)) payrollChg = a - b; // thousands
  }

  // S&P 500 level + % change
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

  // News
  const news = formatNews(get(newsRes));

  return json({
    energy: { brent, wti, henryHub: hh },
    macro: {
      unemployment: unrate,
      corePCE:      corePce,
      michigan,
      mortgage,
      payrollChg,
      claims:       icsa,
      gdpNow:       gdp,
    },
    labor: {
      payrollChangeThousands: payrollChg,
      unemploymentRate:       unrate,
    },
    market: { spxLevel, spxChangePct },
    news,
    lastUpdated: new Date().toISOString(),
  }, 900); // 15-min cache
}

// ── FRED helper ──────────────────────────────────────────────────────────────
/**
 * Returns the latest N observations for a FRED series.
 * limit=1 → returns the single observation object (or null)
 * limit>1 → returns an array of observation objects sorted desc (newest first)
 */
async function fredObs(seriesId, env, limit = 1, units = '') {
  const unitsParam = units ? `&units=${encodeURIComponent(units)}` : '';
  const url =
    `https://api.stlouisfed.org/fred/series/observations` +
    `?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${env.FRED_API_KEY}` +
    `&file_type=json` +
    `&sort_order=desc` +
    `&limit=${limit}` +
    unitsParam;

  const resp = await fetch(url, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
  if (!resp.ok) throw new Error(`FRED ${seriesId}: HTTP ${resp.status}`);
  const data = await resp.json();
  const valid = (data.observations || []).filter(o => o.value && o.value !== '.');
  if (limit === 1) return valid[0] ?? null;
  return valid; // array (newest first)
}

// ── Finnhub helper ───────────────────────────────────────────────────────────
async function finnhubNews(category, env) {
  const url = `https://finnhub.io/api/v1/news?category=${encodeURIComponent(category)}&token=${env.FINNHUB_API_KEY}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'MarketBuzzHub/1.0' } });
  if (!resp.ok) throw new Error(`Finnhub news: HTTP ${resp.status}`);
  return resp.json();
}

// ── Value extractors ─────────────────────────────────────────────────────────
function numFirst(obs) {
  if (obs == null) return null;
  const v = Array.isArray(obs) ? obs[0]?.value : obs.value;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function strFirst(obs) {
  if (obs == null) return null;
  return Array.isArray(obs) ? (obs[0]?.value ?? null) : (obs.value ?? null);
}

// ── News normaliser ──────────────────────────────────────────────────────────
function formatNews(raw) {
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

// ── Misc ─────────────────────────────────────────────────────────────────────
function skip() { return Promise.resolve(null); }

function json(data, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
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

function corsResponse() {
  return new Response('', {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
