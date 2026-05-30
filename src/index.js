/**
 * Finance Ninja — Cloudflare Worker API
 * www.financeninja.work
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Required Secrets (Cloudflare Dashboard → Worker → Settings → Variables):
 *   FINNHUB_API_KEY     → finnhub.io (free tier: 60 req/min)
 *   NEWSAPI_KEY         → newsapi.org (free tier: 100 req/day)
 *
 * TipRanks (add all three):
 *   TIPRANKS_API_KEY    → your TipRanks or reseller API key
 *   TIPRANKS_BASE_URL   → base URL, e.g. https://api.your-reseller.com
 *   TIPRANKS_PT_PATH    → price-target path, e.g. /v1/stocks/price-targets
 *
 * Endpoints:
 *   GET /stock?ticker=AAPL          → Combined quote + TipRanks (used by market-buzz.html)
 *   GET /api/quote?symbol=AAPL      → Live quote only (Finnhub)
 *   GET /api/consensus?symbol=AAPL  → Analyst consensus + SmartScore (TipRanks)
 *   GET /api/bullsbears?symbol=AAPL → Bull/bear AI summary (TipRanks)
 *   GET /api/insiders?symbol=AAPL   → Insider transactions (TipRanks)
 *   GET /api/pt?symbol=AAPL         → Price target consensus (TipRanks)
 *   GET /api/news?q=Apple           → News search (NewsAPI → Finnhub fallback)
 *   GET /api/feed                   → Live market headlines (Finnhub)
 *   GET /api/trending               → Trending stocks (TipRanks → Finnhub fallback)
 *   GET /health                     → Service health check
 */

// ─── Cache TTLs (seconds) ─────────────────────────────────────────────────────
const TTL = {
  quote:     30,    // price quote — refresh fast
  stock:     45,    // combined stock endpoint
  consensus: 300,   // analyst consensus — changes slowly
  bullsbears:600,   // AI summaries — daily update
  insiders:  900,   // insider trades — infrequent
  pt:        600,   // price targets
  news:      120,   // headlines
  feed:       60,   // live feed
  trending:  180,   // trending stocks
};

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;
    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── Health check (no cache) ───────────────────────────────────────────────
    if (path === "/health" || path === "/api/health") {
      return json({
        ok: true,
        service: "finance-ninja-api",
        ts: Date.now(),
        secrets: {
          FINNHUB_API_KEY:    env.FINNHUB_API_KEY    ? "✓" : "✗ missing",
          NEWSAPI_KEY:        env.NEWSAPI_KEY        ? "✓" : "✗ missing",
          TIPRANKS_API_KEY:   env.TIPRANKS_API_KEY   ? "✓" : "— optional",
          TIPRANKS_BASE_URL:  env.TIPRANKS_BASE_URL  ? "✓" : "— optional",
          TIPRANKS_PT_PATH:   env.TIPRANKS_PT_PATH   ? "✓" : "— optional",
        },
        endpoints: ["/stock", "/api/quote", "/api/consensus", "/api/bullsbears",
                    "/api/insiders", "/api/pt", "/api/news", "/api/feed",
                    "/api/trending", "/health"],
      }, 200, cors);
    }

    // ── Edge cache ────────────────────────────────────────────────────────────
    const cache    = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached   = await cache.match(cacheKey);
    if (cached) {
      const h = new Headers(cached.headers);
      h.set("X-Cache", "HIT");
      return new Response(cached.body, { status: cached.status, headers: h });
    }

    try {

      // ══════════════════════════════════════════════════════════════════════
      // /stock?ticker=AAPL
      // Combined endpoint used by market-buzz.html.
      // Returns: { quote, asset, news:[], bullsBears }
      // Tries Finnhub for price, TipRanks for everything else.
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/stock") {
        const ticker = sym(url, "ticker");
        if (!ticker) return json({ error: "ticker is required" }, 400, cors);

        // Fire quote + TipRanks in parallel; TipRanks failures are non-fatal
        const [quoteResult, trResult] = await Promise.allSettled([
          finnhubQuote(ticker, env),
          tipranksAsset(ticker, env),
        ]);

        const q  = quoteResult.status  === "fulfilled" ? quoteResult.value  : null;
        const tr = trResult.status === "fulfilled" ? trResult.value : null;

        if (!q) return json({ error: `Quote unavailable for ${ticker}` }, 404, cors);

        const asset = {
          companyName: tr?.companyName ?? ticker,
          sector:      tr?.sector      ?? "—",
          // TipRanks signals (null if not configured)
          smartScore:              tr?.smartScore              ?? null,
          analystConsensus:        tr?.analystConsensus        ?? buildYahooConsensus(q),
          bestAnalystConsensus:    tr?.bestAnalystConsensus    ?? null,
          priceTarget:             tr?.priceTarget             ?? null,
          priceTargetUpside:       tr?.priceTargetUpside       ?? null,
          hedgeFundSentimentData:  tr?.hedgeFundSentimentData  ?? { rating: null },
          insiderSentimentData:    tr?.insiderSentimentData    ?? { rating: null },
          bloggerSentimentData:    tr?.bloggerSentimentData    ?? { rating: null },
          // Fundamentals from Finnhub supplemented by TipRanks
          peRatio:       tr?.peRatio       ?? null,
          dividendYield: tr?.dividendYield ?? null,
          high52Weeks:   tr?.high52Weeks   ?? q.high52 ?? null,
          low52Weeks:    tr?.low52Weeks    ?? q.low52  ?? null,
          oneMonthGain:    tr?.oneMonthGain    ?? null,
          threeMonthsGain: tr?.threeMonthsGain ?? null,
          ytdGain:         tr?.ytdGain         ?? null,
          yearlyGain:      tr?.yearlyGain      ?? null,
          threeYearsGain:  tr?.threeYearsGain  ?? null,
          calendarEarningsData: tr?.calendarEarningsData ?? { nextEarningsDate: null },
        };

        // Bulls/bears summary (separate TipRanks call, non-fatal)
        let bullsBears = null;
        if (env.TIPRANKS_API_KEY && env.TIPRANKS_BASE_URL) {
          bullsBears = await tipranksGet(ticker, "/v1/stocks/bulls-bears", env).catch(() => null);
          if (bullsBears) {
            bullsBears = {
              bullish: bullsBears.bullishSummary ?? bullsBears.bullish ?? null,
              bearish: bullsBears.bearishSummary ?? bullsBears.bearish ?? null,
              updatedOn: bullsBears.updatedOn ?? bullsBears.updatedAt ?? null,
            };
          }
        }

        const response = json({ quote: q, asset, news: [], bullsBears }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.stock);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/quote?symbol=AAPL   (Finnhub live price)
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/quote") {
        const symbol = sym(url, "symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400, cors);
        if (!env.FINNHUB_API_KEY) return json({ error: "FINNHUB_API_KEY not configured" }, 500, cors);

        const q = await finnhubQuote(symbol, env);
        if (!q) return json({ error: `Symbol not found: ${symbol}` }, 404, cors);

        const response = json(q, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.quote);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/consensus?symbol=AAPL   (TipRanks analyst consensus + SmartScore)
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/consensus") {
        const symbol = sym(url, "symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400, cors);
        requireTipRanks(env);

        const data = await tipranksGet(symbol, "/v1/stocks/consensus", env);
        const response = json({
          symbol,
          source: "TipRanks",
          smartScore:           data.smartScore           ?? null,
          analystConsensus:     data.analystConsensus     ?? null,
          bestAnalystConsensus: data.bestAnalystConsensus ?? null,
          priceTarget:          data.priceTarget          ?? null,
          priceTargetUpside:    data.priceTargetUpside    ?? null,
          hedgeFundSentiment:   data.hedgeFundSentimentData  ?? null,
          insiderSentiment:     data.insiderSentimentData    ?? null,
          bloggerSentiment:     data.bloggerSentimentData    ?? null,
          raw: data,
        }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.consensus);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/bullsbears?symbol=AAPL   (TipRanks AI bull/bear summary)
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/bullsbears") {
        const symbol = sym(url, "symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400, cors);
        requireTipRanks(env);

        const data = await tipranksGet(symbol, "/v1/stocks/bulls-bears", env);
        const response = json({
          symbol,
          source: "TipRanks",
          bullish:   data.bullishSummary ?? data.bullish ?? null,
          bearish:   data.bearishSummary ?? data.bearish ?? null,
          updatedOn: data.updatedOn ?? data.updatedAt ?? null,
          raw: data,
        }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.bullsbears);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/insiders?symbol=AAPL   (TipRanks insider transactions)
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/insiders") {
        const symbol = sym(url, "symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400, cors);
        requireTipRanks(env);

        const data = await tipranksGet(symbol, "/v1/stocks/insider-transactions", env);
        const response = json({
          symbol,
          source:       "TipRanks",
          transactions: data.insiderTransactions ?? data.transactions ?? data ?? [],
          sentiment:    data.insiderSentimentData ?? null,
          raw: data,
        }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.insiders);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/pt?symbol=AAPL   (TipRanks price target consensus)
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/pt") {
        const symbol = sym(url, "symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400, cors);
        requireTipRanks(env);

        // Allow full URL override via TIPRANKS_PT_URL
        let endpoint = "/v1/stocks/price-targets";
        if (env.TIPRANKS_PT_PATH) endpoint = env.TIPRANKS_PT_PATH;

        const data = await tipranksGet(symbol, endpoint, env, env.TIPRANKS_PT_URL);
        const target = {
          mean:      data.mean      ?? data.targetMean      ?? null,
          median:    data.median    ?? data.targetMedian    ?? null,
          high:      data.high      ?? data.targetHigh      ?? null,
          low:       data.low       ?? data.targetLow       ?? null,
          updatedAt: data.updatedAt ?? data.lastUpdated     ?? null,
        };
        const response = json({
          symbol,
          source:          "TipRanks",
          target,
          analysts:        data.analysts        ?? data.analystTargets ?? [],
          recommendations: data.recommendations ?? data.ratingMix      ?? [],
        }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.pt);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/trending   (TipRanks trending → Finnhub most-active fallback)
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/trending") {
        let items = [];

        // Try TipRanks trending first
        if (env.TIPRANKS_API_KEY && env.TIPRANKS_BASE_URL) {
          try {
            const data = await tipranksGet("", "/v1/stocks/trending", env);
            items = (Array.isArray(data) ? data : data.stocks ?? []).slice(0, 20);
          } catch (_) { /* fall through */ }
        }

        // Fallback: Finnhub top stocks by sector
        if (items.length === 0 && env.FINNHUB_API_KEY) {
          try {
            const r = await fhFetch(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${env.FINNHUB_API_KEY}`);
            if (Array.isArray(r)) {
              items = r
                .filter(s => s.type === "Common Stock")
                .slice(0, 20)
                .map(s => ({ ticker: s.symbol, name: s.description }));
            }
          } catch (_) { /* ignore */ }
        }

        const response = json({ trending: items }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.trending);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/news?q=Apple   (NewsAPI → Finnhub fallback)
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/news") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ error: "Missing q parameter" }, 400, cors);

        let items = [];

        // PRIMARY: NewsAPI
        if (env.NEWSAPI_KEY) {
          try {
            const r = await fhFetch(
              `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&sortBy=publishedAt&pageSize=20&language=en&apiKey=${env.NEWSAPI_KEY}`
            );
            if (r?.articles?.length) {
              items = r.articles.map((a, i) => ({
                id: `na-${Date.now()}-${i}`,
                ts: new Date(a.publishedAt).getTime(),
                source: a.source?.name || "News",
                tag: "news",
                title: a.title,
                url: a.url,
                tickers: extractTickers(a.title + " " + (a.description || "")),
                summary: a.description || "",
                image: a.urlToImage || null,
              }));
            }
          } catch (_) {}
        }

        // FALLBACK: Finnhub technology news
        if (items.length === 0 && env.FINNHUB_API_KEY) {
          try {
            const r = await fhFetch(`https://finnhub.io/api/v1/news?category=technology&token=${env.FINNHUB_API_KEY}`);
            if (Array.isArray(r)) {
              items = r.slice(0, 20).map((a, i) => ({
                id: `fh-${Date.now()}-${i}`,
                ts: a.datetime * 1000,
                source: a.source || "Finnhub",
                tag: a.category || "news",
                title: a.headline,
                url: a.url,
                tickers: extractTickers(a.related + " " + a.headline),
                summary: a.summary || "",
                image: a.image || null,
              }));
            }
          } catch (_) {}
        }

        const response = json(items, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.news);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/feed   (Finnhub general market headlines)
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/feed") {
        if (env.FINNHUB_API_KEY) {
          try {
            const r = await fhFetch(`https://finnhub.io/api/v1/news?category=general&token=${env.FINNHUB_API_KEY}`);
            if (Array.isArray(r) && r.length) {
              const items = r.slice(0, 30).map((a, i) => ({
                id: `feed-${i}-${a.datetime}`,
                ts: a.datetime * 1000,
                source: a.source || "Market Feed",
                tag: a.category || "market",
                title: a.headline,
                url: a.url,
                tickers: extractTickers((a.related || "") + " " + a.headline),
                summary: a.summary || "",
                image: a.image || null,
              }));
              const response = json(items, 200, cors);
              await putCache(cache, cacheKey, response, ctx, TTL.feed);
              return response;
            }
          } catch (_) {}
        }
        // Fallback item if Finnhub unavailable
        return json([{
          id: "mb-fallback", ts: Date.now(), source: "Finance Ninja",
          tag: "system", title: "Configure FINNHUB_API_KEY to enable live headlines",
          url: "#", tickers: [], summary: "", image: null,
        }], 200, cors);
      }

      // ── Root / unknown ────────────────────────────────────────────────────
      return json({
        ok: true, service: "Finance Ninja API", domain: "www.financeninja.work",
        routes: ["/stock", "/api/quote", "/api/consensus", "/api/bullsbears",
                 "/api/insiders", "/api/pt", "/api/news", "/api/feed",
                 "/api/trending", "/health"],
      }, 200, cors);

    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: `Server error: ${err.message}` }, 500, cors);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FINNHUB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function fhFetch(url) {
  const r = await fetch(url, { headers: { "User-Agent": "FinanceNinja/1.0", "Accept": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
}

async function finnhubQuote(ticker, env) {
  if (!env.FINNHUB_API_KEY) return null;
  try {
    const [q, profile] = await Promise.allSettled([
      fhFetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${env.FINNHUB_API_KEY}`),
      fhFetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${env.FINNHUB_API_KEY}`),
    ]);
    const d  = q.status === "fulfilled" ? q.value : null;
    const p  = profile.status === "fulfilled" ? profile.value : {};
    if (!d || typeof d.c !== "number" || d.c === 0) return null;
    return {
      price:          d.c,
      change_amount:  +(d.d  ?? 0).toFixed(4),
      change_percent: +(d.dp ?? 0).toFixed(3),
      open:  d.o,
      high:  d.h,
      low:   d.l,
      volume: null,
      market_cap: p.marketCapitalization ? p.marketCapitalization * 1e6 : null,
      high52: d["52WeekHigh"] ?? null,
      low52:  d["52WeekLow"]  ?? null,
      pre_post_market: null,
      // pass through company info from profile
      _companyName: p.name         ?? ticker,
      _sector:      p.finnhubIndustry ?? "—",
    };
  } catch (_) { return null; }
}

// Build a basic consensus object from Finnhub quote data when TipRanks is unavailable
function buildYahooConsensus(q) {
  return { consensus: "—", distribution: { buy: 0, hold: 0, sell: 0 } };
}

// ─────────────────────────────────────────────────────────────────────────────
// TIPRANKS HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function requireTipRanks(env) {
  if (!env.TIPRANKS_API_KEY) throw Object.assign(new Error("TIPRANKS_API_KEY not configured"), { status: 500 });
  if (!env.TIPRANKS_BASE_URL) throw Object.assign(new Error("TIPRANKS_BASE_URL not configured"), { status: 500 });
}

/**
 * Call a TipRanks endpoint.
 * urlOverride: full URL template (use instead of base+path) — supports {symbol} placeholder.
 */
async function tipranksGet(symbol, path, env, urlOverride = null) {
  const base = (env.TIPRANKS_BASE_URL || "").replace(/\/$/, "");
  let url;
  if (urlOverride) {
    url = urlOverride.replace("{symbol}", encodeURIComponent(symbol));
  } else {
    const p    = path.startsWith("/") ? path : `/${path}`;
    const join = p.includes("?") ? "&" : "?";
    url = `${base}${p}${symbol ? `${join}symbol=${encodeURIComponent(symbol)}` : ""}`;
  }

  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.TIPRANKS_API_KEY}`,
      "x-api-key":      env.TIPRANKS_API_KEY,
      "Accept":         "application/json",
      "User-Agent":     "FinanceNinja/1.0",
    },
  });

  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`TipRanks ${r.status}: ${text.slice(0, 200)}`);

  try { return JSON.parse(text); }
  catch (_) { throw new Error(`TipRanks returned non-JSON: ${text.slice(0, 100)}`); }
}

/**
 * Fetch the full TipRanks asset data blob (consensus + sentiment + fundamentals).
 * Maps common TipRanks response shapes to the format market-buzz.html expects.
 */
async function tipranksAsset(ticker, env) {
  if (!env.TIPRANKS_API_KEY || !env.TIPRANKS_BASE_URL) return null;
  try {
    const data = await tipranksGet(ticker, "/v1/stocks/asset-data", env);
    const a = Array.isArray(data?.assetsData) ? data.assetsData[0] : (data?.asset ?? data ?? {});

    return {
      companyName:          a.companyName          ?? a.name           ?? ticker,
      sector:               a.sector               ?? a.industry       ?? "—",
      smartScore:           a.smartScore           ?? null,
      analystConsensus:     a.analystConsensus     ?? null,
      bestAnalystConsensus: a.bestAnalystConsensus ?? null,
      priceTarget:          a.priceTarget          ?? null,
      priceTargetUpside:    a.priceTargetUpside    ?? null,
      hedgeFundSentimentData:  a.hedgeFundSentimentData  ?? null,
      insiderSentimentData:    a.insiderSentimentData    ?? null,
      bloggerSentimentData:    a.bloggerSentimentData    ?? null,
      peRatio:              a.peRatio              ?? null,
      dividendYield:        a.dividendYield        ?? null,
      high52Weeks:          a.high52Weeks          ?? null,
      low52Weeks:           a.low52Weeks           ?? null,
      oneMonthGain:         a.oneMonthGain         ?? null,
      threeMonthsGain:      a.threeMonthsGain      ?? null,
      ytdGain:              a.ytdGain              ?? null,
      yearlyGain:           a.yearlyGain           ?? null,
      threeYearsGain:       a.threeYearsGain       ?? null,
      calendarEarningsData: a.calendarEarningsData ?? { nextEarningsDate: null },
    };
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function putCache(cache, cacheKey, response, ctx, ttlSeconds) {
  try {
    const clone = response.clone();
    const h     = new Headers(clone.headers);
    h.set("Cache-Control", `public, max-age=${ttlSeconds}`);
    const cacheable = new Response(clone.body, { status: clone.status, headers: h });
    const put = () => cache.put(cacheKey, cacheable);
    ctx?.waitUntil ? ctx.waitUntil(put()) : await put();
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "no-store",
      "X-Cache":       "MISS",
      ...extraHeaders,
    },
  });
}

function sym(url, param) {
  return (url.searchParams.get(param) || "").toUpperCase().trim() || null;
}

const KNOWN_TICKERS = new Set([
  "GEV","PWR","MTZ","MYRG","CEG","VST","VRT","SBGSY","ABB","TT","MOD","NVT",
  "CC","ETN","MRVL","COHR","LITE","AVGO","CSCO","ALAB","CRDO","ANET",
  "NVDA","AAPL","MSFT","META","GOOGL","GOOG","AMZN","TSLA","AMD","INTC",
  "SMCI","ARM","TSM","ORCL","IBM","CRM","WMT","COST","JPM","BAC","GS",
  "MS","V","MA","NFLX","DIS","PYPL","SQ","SHOP","SPOT","UBER","LYFT",
  "PLTR","SNOW","DDOG","NET","ZS","CRWD","PANW","S","OKTA",
]);

function extractTickers(text) {
  if (!text) return [];
  const matches = text.match(/\b[A-Z]{1,5}\b/g) || [];
  return [...new Set(matches.filter(m => KNOWN_TICKERS.has(m)))].slice(0, 3);
}
