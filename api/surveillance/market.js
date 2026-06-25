/* ============================================================================
 *  /api/surveillance/market  —  on-demand single-market detail (§4)
 *  ---------------------------------------------------------------------------
 *    GET /api/surveillance/market?platform=&cond=&token=&series=&ticker=
 *                                &mode=&category=&prob=&volume=&won=&resolved=
 *
 *  Returns the FULL enriched payload for one market — its REAL price history
 *  (Kalshi candlesticks / Polymarket CLOB), trades, holders/book and the full
 *  detector set — so the inspector chart mirrors the platform's own chart and
 *  the checks reflect real data, even for markets the rolling deep-scan batch
 *  hasn't reached this cycle (e.g. thin markets). Holds the Kalshi key
 *  server-side and dodges browser CORS, exactly like /feed.
 * ========================================================================== */
"use strict";
const feed = require("./feed.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const q = req.query || {};
  const mode = q.mode === "manipulation" ? "manipulation" : "insider";
  const ref = {
    platform: q.platform === "kalshi" ? "kalshi" : "polymarket",
    cond: q.cond || null, token: q.token || null, series: q.series || null, ticker: q.ticker || null,
    category: q.category || "Other", question: q.question || "", url: q.url || "#",
    prob: q.prob, change24h: q.change24h, volume: q.volume, liquidity: q.liquidity,
    won: q.won, resolved: q.resolved, id: q.id || null,
  };
  // need at least one identifier to fetch real history
  if (!ref.cond && !ref.token && !ref.ticker) { res.status(400).json({ error: "missing market identifier" }); return; }

  try {
    const market = await feed.enrichOne(ref, mode);
    res.status(200).json({ generatedAt: new Date().toISOString(), mode, engine: mode, market });
  } catch (e) {
    res.status(200).json({ error: "enrich failed: " + (e && e.message), market: null });
  }
};
