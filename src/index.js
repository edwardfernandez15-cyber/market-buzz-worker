const API_BASE = "https://www.financeninja.work";

const WATCHLIST_TICKERS = [
  "ABBV", "GOOGL", "AVGO", "LLY", "ASML", "DY", "ARGX",
  "DVN", "MDB", "GH", "HQY", "SBGSY", "MRVL"
];

async function loadMarketNews() {
  try {
    const response = await fetch(`${API_BASE}/api/news/market`);

    if (!response.ok) {
      throw new Error(`Market news failed: ${response.status}`);
    }

    const data = await response.json();
    renderMarketNews(data.articles || data.items || data || []);
  } catch (error) {
    console.error("Market news error:", error);

    const el = document.getElementById("market-news-list");
    if (el) {
      el.innerHTML = `
        <div class="news-err">
          Market news unavailable. Check the Cloudflare Worker route /api/news/market.
        </div>
      `;
    }
  }
}

async function loadStockNews() {
  try {
    const tickers = WATCHLIST_TICKERS.join(",");

    const response = await fetch(
      `${API_BASE}/api/news/stocks?tickers=${encodeURIComponent(tickers)}`
    );

    if (!response.ok) {
      throw new Error(`Stock news failed: ${response.status}`);
    }

    const data = await response.json();

    renderStockNews(data.results || {});
  } catch (error) {
    console.error("Stock news error:", error);

    const el = document.getElementById("stock-news-list");
    if (el) {
      el.innerHTML = `
        <div class="news-err">
          Stock news unavailable. Check the Cloudflare Worker route /api/news/stocks.
        </div>
      `;
    }
  }
}

async function loadMarketCalendar() {
  try {
    const [macroRes, calendarRes] = await Promise.all([
      fetch(`${API_BASE}/api/fred/macro`),
      fetch(`${API_BASE}/api/fred/calendar`)
    ]);

    if (!macroRes.ok) {
      throw new Error(`FRED macro failed: ${macroRes.status}`);
    }

    if (!calendarRes.ok) {
      throw new Error(`FRED calendar failed: ${calendarRes.status}`);
    }

    const macro = await macroRes.json();
    const calendar = await calendarRes.json();

    renderMacroSnapshot(macro);
    renderMarketCalendar(calendar.events || calendar.releases || calendar || []);
  } catch (error) {
    console.error("Market calendar error:", error);

    const macroEl = document.getElementById("macro-snapshot");
    const calEl = document.getElementById("market-calendar-list");

    if (macroEl) {
      macroEl.innerHTML = `
        <div class="cal-loading">
          Macro snapshot unavailable. Check /api/fred/macro.
        </div>
      `;
    }

    if (calEl) {
      calEl.innerHTML = `
        <div class="cal-loading">
          Market calendar unavailable. Check /api/fred/calendar.
        </div>
      `;
    }
  }
}
