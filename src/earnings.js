/**
 * GET /api/earnings?tickers=ABBV,GOOGL,...&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Cloudflare Pages Function — proxies Finnhub earnings calendar.
 * Requires secret: FINNHUB_API_KEY (set in CF Pages → Settings → Environment variables)
 *
 * Query params:
 *   tickers  — comma-separated list; if provided, response is filtered to those symbols only
 *   from     — start date (YYYY-MM-DD); defaults to today
 *   to       — end date  (YYYY-MM-DD); defaults to +120 days
 */
export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return corsResponse();
  }

  if (!env.FINNHUB_API_KEY) {
    return jsonError('FINNHUB_API_KEY secret is not set in Cloudflare Pages environment variables.', 500);
  }

  // Date range
  const today  = new Date().toISOString().slice(0, 10);
  const plus120 = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  const from   = url.searchParams.get('from') || today;
  const to     = url.searchParams.get('to')   || plus120;

  // Optional ticker filter
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

    const data = await resp.json();
    const all  = Array.isArray(data) ? data : (data.earningsCalendar || []);

    // Filter to our portfolio tickers when supplied
    const filtered = tickerSet.size > 0
      ? all.filter(e => tickerSet.has((e.symbol || '').toUpperCase()))
      : all;

    // Normalise to a consistent shape
    const normalised = filtered.map(e => ({
      symbol:          e.symbol || e.ticker || '',
      date:            e.date   || '',
      hour:            e.hour   || '',                // 'amc' | 'bmo' | ''
      epsEstimate:     e.epsEstimate     ?? null,
      revenueEstimate: e.revenueEstimate ?? null,
      fiscalQuarter:   e.quarter || e.fiscalQuarter || '',
      period:          e.period  || '',
    }));

    return json({ earningsCalendar: normalised }, 900); // 15-min cache
  } catch (e) {
    return jsonError(e.message, 502);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
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
