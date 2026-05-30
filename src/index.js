export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (path === "/health") {
      return json({ ok: true, service: "market-buzz-api", ts: Date.now() }, 200, cors);
    }

    // /api/quote?symbol=AMZN
    if (path === "/api/quote") {
      const symbol = (url.searchParams.get("symbol") || "").toUpperCase().trim();
      if (!symbol) return json({ error: "Missing symbol" }, 400, cors);

      const token = env.FINNHUB_API_KEY;
      if (!token) return json({ error: "Missing FINNHUB_API_KEY" }, 500, cors);

      const r = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`
      );
      const d = await r.json();

      if (!d || typeof d.c !== "number" || d.c === 0) {
        return json({ error: "Symbol not found or no price data", symbol }, 404, cors);
      }

      return json(
        {
          symbol,
          price: d.c,
          change: d.d,
          changePct: d.dp,
          high: d.h,
          low: d.l,
          open: d.o,
          prevClose: d.pc,
          ts: Date.now(),
        },
        200,
        cors
      );
    }

    // /api/news?q=Amazon
    if (path === "/api/news") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ error: "Missing q" }, 400, cors);

      const apiKey = env.NEWSAPI_KEY;
      if (!apiKey) return json({ error: "Missing NEWSAPI_KEY" }, 500, cors);

      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&sortBy=publishedAt&pageSize=12&apiKey=${apiKey}`
      );
      const data = await r.json();

      const items = (data.articles || []).map((a, i) => ({
        id: `${Date.now()}-${i}`,
        ts: new Date(a.publishedAt).getTime(),
        source: a.source?.name || "News",
        tag: "news",
        title: a.title,
        url: a.url,
        tickers: [],
        summary: a.description || "",
      }));

      return json(items, 200, cors);
    }

    // /api/feed
    if (path === "/api/feed") {
      const now = Date.now();
      return json(
        [
          {
            id: "mb-1",
            ts: now - 1000 * 60 * 5,
            source: "Market Buzz",
            tag: "macro",
            title: "Market Buzz live feed is running ✅",
            url: "#news",
            tickers: ["AMZN", "WMT", "COST"],
            summary: "Replace this with aggregated headlines + your commentary.",
          },
        ],
        200,
        cors
      );
    }

    return json(
      { ok: true, message: "Market Buzz API online", routes: ["/api/quote", "/api/news", "/api/feed"] },
      200,
      cors
    );
  },
};

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
