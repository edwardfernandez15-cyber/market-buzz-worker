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
  quote:      30,   // price quote — refresh fast
  stock:      45,   // combined stock endpoint
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
          FINNHUB_API_KEY:  env.FINNHUB_API_KEY  ? "✓" : "✗ missing — required for quotes",
          TIPRANKS_API_KEY: env.TIPRANKS_API_KEY ? "✓" : "— optional (get free key at mcp.tipranks.com)",
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
      // Combined endpoint — quote from Finnhub, fundamentals from TipRanks.
      // TipRanks failures are non-fatal; site degrades gracefully.
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/stock") {
        const ticker = sym(url, "ticker");
        if (!ticker) return json({ error: "ticker is required" }, 400, cors);

        const [quoteResult, trResult] = await Promise.allSettled([
          finnhubQuote(ticker, env),
          tipranksAsset(ticker, env),
        ]);

        const q  = quoteResult.status === "fulfilled" ? quoteResult.value : null;
        const tr = trResult.status    === "fulfilled" ? trResult.value    : null;

        if (!q) return json({ error: `Quote unavailable for ${ticker}` }, 404, cors);

        // FIX: fall back to Finnhub profile fields when TipRanks isn't configured
        const asset = {
          companyName: tr?.companyName ?? q._companyName ?? ticker,
          sector:      tr?.sector      ?? q._sector      ?? "—",

          smartScore:             tr?.smartScore             ?? null,
          analystConsensus:       tr?.analystConsensus       ?? { consensus: "—", distribution: { buy: 0, hold: 0, sell: 0 } },
          bestAnalystConsensus:   tr?.bestAnalystConsensus   ?? null,
          priceTarget:            tr?.priceTarget            ?? null,
          priceTargetUpside:      tr?.priceTargetUpside      ?? null,
          hedgeFundSentimentData: tr?.hedgeFundSentimentData ?? { rating: null },
          insiderSentimentData:   tr?.insiderSentimentData   ?? { rating: null },
          bloggerSentimentData:   tr?.bloggerSentimentData   ?? { rating: null },

          // FIX: use Finnhub metrics for fundamentals when TipRanks is off
          peRatio:        tr?.peRatio        ?? q._peRatio        ?? null,
          dividendYield:  tr?.dividendYield  ?? q._dividendYield  ?? null,
          high52Weeks:    tr?.high52Weeks    ?? q._high52         ?? null,
          low52Weeks:     tr?.low52Weeks     ?? q._low52          ?? null,

          oneMonthGain:    tr?.oneMonthGain    ?? null,
          threeMonthsGain: tr?.threeMonthsGain ?? null,
          ytdGain:         tr?.ytdGain         ?? null,
          yearlyGain:      tr?.yearlyGain      ?? null,
          threeYearsGain:  tr?.threeYearsGain  ?? null,

          calendarEarningsData: tr?.calendarEarningsData ?? { nextEarningsDate: null },
        };

        // Bulls/bears via TipRanks MCP (non-fatal)
        let bullsBears = null;
        if (env.TIPRANKS_API_KEY) {
          try {
            const bb = await tipranksCall("get_bulls_bears_summary", { tickers: ticker }, env);
            const d = Array.isArray(bb?.data) ? bb.data[0] : (bb ?? {});
            if (d.bullishSummary || d.bearishSummary || d.bullish || d.bearish) {
              bullsBears = {
                bullishSummary: d.bullishSummary ?? d.bullish   ?? null,
                bearishSummary: d.bearishSummary ?? d.bearish   ?? null,
                updatedOn:      d.updatedOn      ?? d.updatedAt ?? null,
              };
            }
          } catch (_) {}
        }

        // News: TipRanks get_assets_news (has sentiment) → Yahoo Finance fallback
        let stockNews = [];
        if (env.TIPRANKS_API_KEY) {
          try {
            const nd = await tipranksCall("get_assets_news", { tickers: ticker, count: 8 }, env);
            const articles = nd?.assetNewsArticles ?? nd?.news ?? (Array.isArray(nd) ? nd : []);
            if (articles.length) {
              stockNews = articles.map(a => ({
                ticker,
                title:       a.title,
                url:         a.url || a.link || "#",
                siteName:    a.siteName || a.publisher || a.source || "TipRanks",
                sentiment:   a.sentiment || "Neutral",
                publishTime: a.publishTime || a.publishedAt || new Date().toISOString(),
              }));
            }
          } catch (_) {}
        }
        if (stockNews.length === 0) {
          try {
            const yhUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=8&quotesCount=0`;
            const yh = await fetch(yhUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
            if (yh.ok) {
              const yd = await yh.json();
              stockNews = (yd?.news ?? []).map(a => ({
                ticker,
                title:       a.title,
                url:         a.link || "#",
                siteName:    a.publisher || "Yahoo Finance",
                sentiment:   "Neutral",
                publishTime: new Date((a.providerPublishTime ?? 0) * 1000).toISOString(),
              }));
            }
          } catch (_) {}
        }

        const response = json({ quote: q, asset, news: stockNews, bullsBears }, 200, cors);
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
      // /api/consensus?symbol=AAPL
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/consensus") {
        const symbol = sym(url, "symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400, cors);
        requireTipRanks(env);

        const data = await tipranksCall("get_assets_data", { tickers: symbol }, env);
        const a = Array.isArray(data?.assetsData) ? data.assetsData[0] : (data ?? {});
        const response = json({
          symbol, source: "TipRanks",
          smartScore:           a.smartScore           ?? null,
          analystConsensus:     a.analystConsensus     ?? null,
          bestAnalystConsensus: a.bestAnalystConsensus ?? null,
          priceTarget:          a.priceTarget          ?? null,
          priceTargetUpside:    a.priceTargetUpside    ?? null,
          hedgeFundSentiment:   a.hedgeFundSentimentData ?? null,
          insiderSentiment:     a.insiderSentimentData   ?? null,
          bloggerSentiment:     a.bloggerSentimentData   ?? null,
        }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.consensus);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/bullsbears?symbol=AAPL
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/bullsbears") {
        const symbol = sym(url, "symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400, cors);
        requireTipRanks(env);

        const data = await tipranksCall("get_bulls_bears_summary", { tickers: symbol }, env);
        const d = Array.isArray(data?.data) ? data.data[0] : (data ?? {});
        const response = json({
          symbol, source: "TipRanks",
          bullish:   d.bullishSummary ?? d.bullish   ?? null,
          bearish:   d.bearishSummary ?? d.bearish   ?? null,
          updatedOn: d.updatedOn      ?? d.updatedAt ?? null,
        }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.bullsbears);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/insiders?symbol=AAPL
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/insiders") {
        const symbol = sym(url, "symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400, cors);
        requireTipRanks(env);

        const data = await tipranksCall("get_insider_transactions", { tickers: symbol }, env);
        const response = json({
          symbol, source: "TipRanks",
          transactions: data.insiderTransactions ?? data.transactions ?? data ?? [],
          sentiment:    data.insiderSentimentData ?? null,
        }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.insiders);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/pt?symbol=AAPL  — price targets via get_assets_data
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/pt") {
        const symbol = sym(url, "symbol");
        if (!symbol) return json({ error: "Missing symbol" }, 400, cors);
        requireTipRanks(env);

        const data = await tipranksCall("get_assets_data", { tickers: symbol }, env);
        const a = Array.isArray(data?.assetsData) ? data.assetsData[0] : (data ?? {});
        const response = json({
          symbol, source: "TipRanks",
          priceTarget:       a.priceTarget       ?? null,
          priceTargetUpside: a.priceTargetUpside ?? null,
          analystConsensus:  a.analystConsensus  ?? null,
        }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.pt);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/trending
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/trending") {
        let items = [];

        if (env.TIPRANKS_API_KEY) {
          try {
            const data = await tipranksCall("get_trending_stocks", {}, env);
            items = (Array.isArray(data) ? data : data.stocks ?? []).slice(0, 20);
          } catch (_) {}
        }

        if (items.length === 0 && env.FINNHUB_API_KEY) {
          try {
            const r = await fhFetch(`https://finnhub.io/api/v1/news?category=general&token=${env.FINNHUB_API_KEY}`);
            if (Array.isArray(r)) {
              const seen = new Set();
              items = r.flatMap(a => extractTickers((a.related||"")+" "+a.headline))
                .filter(t => t && !seen.has(t) && seen.add(t))
                .slice(0, 20).map(t => ({ ticker: t }));
            }
          } catch (_) {}
        }

        const response = json({ trending: items }, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.trending);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/news?q=Apple
      // Primary: Yahoo Finance (free, no key). Fallback: Finnhub.
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/news") {
        const q = (url.searchParams.get("q") || "AI infrastructure data center").trim();

        let items = [];

        // 1. Yahoo Finance news search (no API key needed)
        try {
          const yhUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=20&quotesCount=0&enableFuzzyQuery=false`;
          const yh = await fetch(yhUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
          if (yh.ok) {
            const data = await yh.json();
            const news = data?.news ?? [];
            if (news.length) {
              items = news.map((a, i) => ({
                id:      `yh-${Date.now()}-${i}`,
                ts:      (a.providerPublishTime ?? 0) * 1000,
                source:  a.publisher || "Yahoo Finance",
                tag:     "news",
                title:   a.title,
                url:     a.link || "#",
                tickers: (a.relatedTickers ?? []).map(t => t.replace("^","").toUpperCase()),
                summary: a.summary || "",
                image:   a.thumbnail?.resolutions?.[0]?.url || null,
              }));
            }
          }
        } catch (_) {}

        // 2. Finnhub fallback
        if (items.length === 0 && env.FINNHUB_API_KEY) {
          try {
            const r = await fhFetch(`https://finnhub.io/api/v1/news?category=technology&token=${env.FINNHUB_API_KEY}`);
            if (Array.isArray(r)) {
              items = r.slice(0, 20).map((a, i) => ({
                id:      `fh-${Date.now()}-${i}`,
                ts:      a.datetime * 1000,
                source:  a.source || "Finnhub",
                tag:     a.category || "news",
                title:   a.headline,
                url:     a.url,
                tickers: extractTickers((a.related || "") + " " + a.headline),
                summary: a.summary || "",
                image:   a.image || null,
              }));
            }
          } catch (_) {}
        }

        const response = json(items, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.news);
        return response;
      }

      // ══════════════════════════════════════════════════════════════════════
      // /api/feed  — Live market headlines
      // Primary: Yahoo Finance general news (no key). Fallback: Finnhub.
      // ══════════════════════════════════════════════════════════════════════
      if (path === "/api/feed") {
        let items = [];

        // 1. Yahoo Finance general market news (no API key needed)
        try {
          const yhUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=stock+market+earnings&newsCount=30&quotesCount=0`;
          const yh = await fetch(yhUrl, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
          if (yh.ok) {
            const data = await yh.json();
            const news = data?.news ?? [];
            if (news.length) {
              items = news.map((a, i) => ({
                id:      `feed-yh-${i}-${a.providerPublishTime ?? i}`,
                ts:      (a.providerPublishTime ?? 0) * 1000,
                source:  a.publisher || "Yahoo Finance",
                tag:     "market",
                title:   a.title,
                url:     a.link || "#",
                tickers: (a.relatedTickers ?? []).map(t => t.replace("^","").toUpperCase()),
                summary: a.summary || "",
                image:   a.thumbnail?.resolutions?.[0]?.url || null,
              }));
            }
          }
        } catch (_) {}

        // 2. Finnhub fallback (requires key)
        if (items.length === 0 && env.FINNHUB_API_KEY) {
          try {
            const r = await fhFetch(`https://finnhub.io/api/v1/news?category=general&token=${env.FINNHUB_API_KEY}`);
            if (Array.isArray(r) && r.length) {
              items = r.slice(0, 30).map((a, i) => ({
                id:      `feed-fh-${i}-${a.datetime}`,
                ts:      a.datetime * 1000,
                source:  a.source || "Market Feed",
                tag:     a.category || "market",
                title:   a.headline,
                url:     a.url,
                tickers: extractTickers((a.related || "") + " " + a.headline),
                summary: a.summary || "",
                image:   a.image || null,
              }));
            }
          } catch (_) {}
        }

        if (items.length === 0) {
          return json([{
            id: "fn-fallback", ts: Date.now(), source: "Finance Ninja",
            tag: "system", title: "Live feed loading — check back shortly",
            url: "#", tickers: [], summary: "", image: null,
          }], 200, cors);
        }

        const response = json(items, 200, cors);
        await putCache(cache, cacheKey, response, ctx, TTL.feed);
        return response;
      }

      // ── Root ──────────────────────────────────────────────────────────────
      return json({
        ok: true,
        service: "Finance Ninja API",
        domain:  "www.financeninja.work",
        routes:  ["/stock", "/api/quote", "/api/consensus", "/api/bullsbears",
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
  const r = await fetch(url, {
    headers: { "User-Agent": "FinanceNinja/1.0", "Accept": "application/json" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
}

async function finnhubQuote(ticker, env) {
  if (!env.FINNHUB_API_KEY) return null;
  try {
    // FIX: fetch quote + profile + metrics in parallel
    // Metrics gives us 52W range, PE, dividendYield — quote alone does NOT include these
    const [qRes, profileRes, metricsRes] = await Promise.allSettled([
      fhFetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${env.FINNHUB_API_KEY}`),
      fhFetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${env.FINNHUB_API_KEY}`),
      fhFetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${env.FINNHUB_API_KEY}`),
    ]);

    const d = qRes.status       === "fulfilled" ? qRes.value       : null;
    const p = profileRes.status === "fulfilled" ? profileRes.value : {};
    const m = metricsRes.status === "fulfilled" ? (metricsRes.value?.metric ?? {}) : {};

    if (!d || typeof d.c !== "number" || d.c === 0) return null;

    return {
      // Quote fields (consumed by market-buzz.html)
      price:          d.c,
      change_amount:  +(d.d  ?? 0).toFixed(4),
      change_percent: +(d.dp ?? 0).toFixed(3),
      open:           d.o,
      high:           d.h,
      low:            d.l,
      volume:         null,
      market_cap:     p.marketCapitalization ? p.marketCapitalization * 1e6 : null,
      pre_post_market: null,

      // FIX: 52W range from metrics endpoint (not quote)
      _high52:        m["52WeekHigh"]    ?? null,
      _low52:         m["52WeekLow"]     ?? null,

      // Fundamentals from metrics (used as fallback when TipRanks is off)
      _peRatio:       m.peBasicExclExtraTTM ?? m.peTTM ?? null,
      _dividendYield: m.dividendYieldIndicatedAnnual ?? null,

      // Company info from profile
      _companyName:   p.name              ?? ticker,
      _sector:        p.finnhubIndustry   ?? "—",
    };
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TIPRANKS MCP HELPERS
// Calls the TipRanks MCP server via JSON-RPC 2.0.
// Only TIPRANKS_API_KEY needed — get a free key at mcp.tipranks.com/dev/signup
// Free tier: 5 rpm / 25 req/day. Upgrade at mcp.tipranks.com/dev/billing.
// ─────────────────────────────────────────────────────────────────────────────

const TIPRANKS_MCP_URL = "https://mcp.tipranks.com/mcp";

function requireTipRanks(env) {
  if (!env.TIPRANKS_API_KEY) throw Object.assign(
    new Error("TIPRANKS_API_KEY not configured — get a free key at mcp.tipranks.com/dev/signup"),
    { status: 500 }
  );
}

// Call any TipRanks MCP tool by name.
// Returns the parsed JSON payload from result.content[0].text.
async function tipranksCall(toolName, args, env) {
  const url = `${TIPRANKS_MCP_URL}/?apikey=${encodeURIComponent(env.TIPRANKS_API_KEY)}`;
  const r = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      Date.now(),
      method:  "tools/call",
      params:  { name: toolName, arguments: args },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`TipRanks MCP HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const json = await r.json();
  if (json?.error) throw new Error(`TipRanks MCP error: ${JSON.stringify(json.error)}`);
  // MCP wraps the payload as a JSON string in result.content[0].text
  const raw = json?.result?.content?.[0]?.text;
  if (!raw) throw new Error(`Empty MCP result from ${toolName}`);
  return JSON.parse(raw);
}

// Get the 40-field asset snapshot for a ticker using get_assets_data.
async function tipranksAsset(ticker, env) {
  if (!env.TIPRANKS_API_KEY) return null;
  try {
    const data = await tipranksCall("get_assets_data", { tickers: ticker }, env);
    const a = Array.isArray(data?.assetsData) ? data.assetsData[0] : (data?.asset ?? data ?? {});
    return {
      companyName:             a.companyName          ?? a.name        ?? ticker,
      sector:                  a.sector               ?? a.industry    ?? "—",
      smartScore:              a.smartScore           ?? null,
      analystConsensus:        a.analystConsensus     ?? null,
      bestAnalystConsensus:    a.bestAnalystConsensus ?? null,
      priceTarget:             a.priceTarget          ?? null,
      priceTargetUpside:       a.priceTargetUpside    ?? null,
      hedgeFundSentimentData:  a.hedgeFundSentimentData  ?? null,
      insiderSentimentData:    a.insiderSentimentData    ?? null,
      bloggerSentimentData:    a.bloggerSentimentData    ?? null,
      peRatio:                 a.peRatio              ?? null,
      dividendYield:           a.dividendYield        ?? null,
      high52Weeks:             a.high52Weeks          ?? null,
      low52Weeks:              a.low52Weeks           ?? null,
      oneMonthGain:            a.oneMonthGain         ?? null,
      threeMonthsGain:         a.threeMonthsGain      ?? null,
      ytdGain:                 a.ytdGain              ?? null,
      yearlyGain:              a.yearlyGain           ?? null,
      threeYearsGain:          a.threeYearsGain       ?? null,
      calendarEarningsData:    a.calendarEarningsData ?? { nextEarningsDate: null },
    };
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
