/**
 * Market Buzz API — Cloudflare Worker
 * ────────────────────────────────────────────────────
 * 
 * Required Secrets (set via Cloudflare dashboard):
 *   FINNHUB_API_KEY  → finnhub.io
 *   NEWSAPI_KEY      → newsapi.org
 * 
 * Endpoints:
 *   GET /health                      → Service health check
 *   GET /api/health                  → Same as /health (alias)
 *   GET /api/quote?symbol=AAPL       → Live stock quote
 *   GET /api/news?q=Apple            → News search (NewsAPI → Finnhub fallback)
 *   GET /api/feed                    → Market headlines (Finnhub general news)
 * 
 * Features:
 *   ✓ Edge caching (reduces API calls, stays under free-tier limits)
 *   ✓ Multi-source fallback (NewsAPI → Finnhub for news)
 *   ✓ Live feed (real headlines, not placeholder)
 *   ✓ Full CORS support
 *   ✓ Detailed error responses
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // ─── CORS preflight ───
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // ─── HEALTH CHECK (no caching) ───
    if (path === "/health" || path === "/api/health") {
      return json({
        ok: true,
        service: "market-buzz-api",
        ts: Date.now(),
        secrets: {
          FINNHUB_API_KEY: env.FINNHUB_API_KEY ? "✓ configured" : "✗ missing",
          NEWSAPI_KEY: env.NEWSAPI_KEY ? "✓ configured" : "✗ missing",
        },
        endpoints: ["/api/quote", "/api/news", "/api/feed"],
      }, 200, cors);
    }

    // ─── EDGE CACHE LOOKUP ───
    // Cache responses to reduce API calls and avoid rate limits.
    // NewsAPI free tier = 100/day, Finnhub free tier = 60/min.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("X-Cache", "HIT");
      return new Response(cached.body, { status: cached.status, headers });
    }

    try {
      // ═════════════════════════════════════════════════
      // /api/quote?symbol=AAPL  (Finnhub)
      // ═════════════════════════════════════════════════
      if (path === "/api/quote") {
        const symbol = (url.searchParams.get("symbol") || "").toUpperCase().trim();
        if (!symbol) return json({ error: "Missing symbol parameter" }, 400, cors);
        if (!env.FINNHUB_API_KEY) return json({ error: "FINNHUB_API_KEY not configured" }, 500, cors);

        const r = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${env.FINNHUB_API_KEY}`,
          { headers: { "User-Agent": "MarketBuzz/1.0" } }
        );

        if (!r.ok) {
          return json({ error: `Finnhub returned ${r.status}`, symbol }, r.status, cors);
        }

        const d = await r.json();
        if (!d || typeof d.c !== "number" || d.c === 0) {
          return json({ error: "Symbol not found or no price data", symbol }, 404, cors);
        }

        const response = json({
          symbol,
          price: d.c,
          change: d.d,
          changePct: d.dp,
          high: d.h,
          low: d.l,
          open: d.o,
          prevClose: d.pc,
          ts: Date.now(),
        }, 200, cors);

        // Cache quote for 30 seconds (intraday prices change fast)
        await cacheResponse(cache, cacheKey, response, ctx, 30);
        return response;
      }

      // ═════════════════════════════════════════════════
      // /api/news?q=Apple  (NewsAPI → Finnhub fallback)
      // ═════════════════════════════════════════════════
      if (path === "/api/news") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ error: "Missing q parameter" }, 400, cors);

        let items = [];

        // PRIMARY: NewsAPI (best quality headlines)
        if (env.NEWSAPI_KEY) {
          try {
            const r = await fetch(
              `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&sortBy=publishedAt&pageSize=20&language=en&apiKey=${env.NEWSAPI_KEY}`,
              { headers: { "User-Agent": "MarketBuzz/1.0" } }
            );
            if (r.ok) {
              const data = await r.json();
              if (data.articles && data.articles.length) {
                items = data.articles.map((a, i) => ({
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
            }
          } catch (e) {
            console.warn("NewsAPI failed:", e.message);
          }
        }

        // FALLBACK: Finnhub technology news (more reliable from server-side)
        if (items.length === 0 && env.FINNHUB_API_KEY) {
          try {
            const r = await fetch(
              `https://finnhub.io/api/v1/news?category=technology&token=${env.FINNHUB_API_KEY}`,
              { headers: { "User-Agent": "MarketBuzz/1.0" } }
            );
            if (r.ok) {
              const data = await r.json();
              if (Array.isArray(data)) {
                items = data.slice(0, 20).map((a, i) => ({
                  id: `fh-${Date.now()}-${i}`,
                  ts: a.datetime * 1000,
                  source: a.source || "Finnhub",
                  tag: a.category || "news",
                  title: a.headline,
                  url: a.url,
                  tickers: a.related ? a.related.split(",").filter(t => t.length <= 5).slice(0, 3) : [],
                  summary: a.summary || "",
                  image: a.image || null,
                }));
              }
            }
          } catch (e) {
            console.warn("Finnhub news fallback failed:", e.message);
          }
        }

        const response = json(items, 200, cors);
        // Cache news for 2 minutes
        await cacheResponse(cache, cacheKey, response, ctx, 120);
        return response;
      }

      // ═════════════════════════════════════════════════
      // /api/feed (Live market headlines from Finnhub general news)
      // ═════════════════════════════════════════════════
      if (path === "/api/feed") {
        if (env.FINNHUB_API_KEY) {
          try {
            const r = await fetch(
              `https://finnhub.io/api/v1/news?category=general&token=${env.FINNHUB_API_KEY}`,
              { headers: { "User-Agent": "MarketBuzz/1.0" } }
            );
            if (r.ok) {
              const data = await r.json();
              if (Array.isArray(data) && data.length > 0) {
                const items = data.slice(0, 30).map((a, i) => ({
                  id: `feed-${i}-${a.datetime}`,
                  ts: a.datetime * 1000,
                  source: a.source || "Market Feed",
                  tag: a.category || "market",
                  title: a.headline,
                  url: a.url,
                  tickers: a.related ? a.related.split(",").filter(t => t.length <= 5).slice(0, 3) : [],
                  summary: a.summary || "",
                  image: a.image || null,
                }));
                const response = json(items, 200, cors);
                // Cache feed for 60 seconds
                await cacheResponse(cache, cacheKey, response, ctx, 60);
                return response;
              }
            }
          } catch (e) {
            console.warn("Feed error:", e.message);
          }
        }

        // Fallback if Finnhub fails or no key configured
        return json([{
          id: "mb-fallback",
          ts: Date.now() - 1000 * 60 * 5,
          source: "Market Buzz",
          tag: "system",
          title: "Live feed unavailable — check FINNHUB_API_KEY",
          url: "#",
          tickers: [],
          summary: "Configure your FINNHUB_API_KEY secret to enable live market headlines.",
        }], 200, cors);
      }

      // ─── Root / unknown route ───
      return json({
        ok: true,
        message: "Market Buzz API online",
        routes: ["/api/quote", "/api/news", "/api/feed", "/api/health"],
        docs: "Each route uses your Cloudflare Worker secrets (FINNHUB_API_KEY, NEWSAPI_KEY)",
      }, 200, cors);

    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: `Server error: ${err.message}` }, 500, cors);
    }
  },
};

// ═══════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Cache": "MISS",
      ...extraHeaders,
    },
  });
}

/**
 * Cache a response for the specified TTL (seconds).
 * Uses Cloudflare's edge cache.
 */
async function cacheResponse(cache, cacheKey, response, ctx, ttlSeconds) {
  try {
    const responseToCache = response.clone();
    const headers = new Headers(responseToCache.headers);
    headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
    const cacheableResponse = new Response(responseToCache.body, {
      status: responseToCache.status,
      headers,
    });
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(cache.put(cacheKey, cacheableResponse));
    } else {
      await cache.put(cacheKey, cacheableResponse);
    }
  } catch (e) {
    console.warn("Cache write failed:", e.message);
  }
}

/**
 * Extract stock tickers from text using a known universe.
 */
function extractTickers(text) {
  if (!text) return [];
  const matches = text.match(/\b[A-Z]{2,5}\b/g) || [];
  const known = new Set([
    // Your AI infrastructure universe
    "GEV", "PWR", "MTZ", "MYRG", "CEG", "VST", "VRT", "SBGSY", "ABB", "TT",
    "MOD", "NVT", "CC", "ETN", "MRVL", "COHR", "LITE", "AVGO", "CSCO",
    "ALAB", "CRDO", "ANET",
    // Major tech tickers
    "NVDA", "AAPL", "MSFT", "META", "GOOGL", "GOOG", "AMZN", "TSLA",
    "AMD", "INTC", "SMCI", "ARM", "TSM", "ORCL", "IBM", "CRM",
    // Common references
    "WMT", "COST", "JPM", "BAC", "GS", "MS", "V", "MA",
  ]);
  return [...new Set(matches.filter(m => known.has(m)))].slice(0, 3);
}
