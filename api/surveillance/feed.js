/* ============================================================================
 *  /api/surveillance/feed  —  live surveillance collector (Vercel function)
 *  ---------------------------------------------------------------------------
 *  Server-side so it can hold the Kalshi key and dodge browser CORS. Pulls
 *  PUBLIC market data from Polymarket (no key) and Kalshi (public market data;
 *  signs requests with the Kalshi RSA key if present for higher limits), runs a
 *  first set of detectors, and returns the SAME shape the model's sample feed
 *  uses: { generatedAt, sources, alerts:[ {id,ts,platform,market,detector,sev,
 *  metric,spark,note,gap} ] }. The model polls this and falls back to its
 *  embedded sample if the call fails, so nothing ever looks broken.
 *
 *  Detection-side only, public data only. This is a first version to iterate on
 *  against the live deploy (the build sandbox can't reach these APIs), so each
 *  source is wrapped in try/catch and degrades to whatever it can compute.
 *
 *  Env (optional): KALSHI_KEY_ID, KALSHI_PRIVATE_KEY  (read-only key).
 * ========================================================================== */
"use strict";

const crypto = require("crypto");

const GAP = {
  vol_liq: "Aggressive position-filling is not, by itself, a violation. It completes one only if paired with misappropriated nonpublic information or a manipulative scheme.",
  accum: "A large one-directional position is a signal, not proof. A violation still needs misappropriated nonpublic information or a breached duty.",
  vacuum: "A whale moving thin odds is anomalous, not illegal, unless the trade rests on nonpublic information used in breach of a duty, or is non-bona-fide.",
  lead: "A pre-event move can be informed trading or a sharp read of public signals. Proof requires nonpublic information and, federally, a breached duty.",
  fresh: "A fresh wallet and good timing are a strong anomaly signal, not a proven breach.",
};
const NOTE = {
  vol_liq: "Trading volume far exceeds the market's resting liquidity.",
  accum: "A steady one-sided position built relative to the book.",
  vacuum: "An outsized single fill moved the odds on a thin market.",
  lead: "Implied probability moved sharply ahead of the expected catalyst.",
  fresh: "A recently active wallet placed an outsized bet on a niche market.",
};

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}
async function getJSON(url, opts) {
  const to = withTimeout((opts && opts.timeout) || 8000);
  try {
    const r = await fetch(url, { headers: (opts && opts.headers) || {}, signal: to.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { to.done(); }
}
const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
function alert(o) {
  return {
    id: o.id, ts: o.ts, platform: o.platform, market: o.market, detector: o.detector,
    sev: o.sev, metric: o.metric, spark: o.spark || null,
    note: o.note || NOTE[o.detector] || "", gap: o.gap || GAP[o.detector] || "Anomalous, not proof of a violation.",
  };
}
function hhmm() { return new Date().toISOString().slice(11, 16) + " UTC"; }

/* --------------------------------------------------------- topic classifier -
 * Insider trading only makes sense where the OUTCOME turns on nonpublic
 * information: geopolitics, government/political decisions, leakable economic
 * data, and corporate events. Sports, esports, and crypto/index price levels
 * are efficient + public, so we drop them — that is where the noise was. */
function topic(text) {
  const s = String(text || "").toLowerCase();
  if (/\bvs\.?\b|spread:|o\/u|over\/under|moneyline|win on \d{4}-|world cup|counter-?strike|esports|goalscorer|glove|\bwnba\b|\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|\bufc\b|\bf1\b|halftime|to score|\bbo\d\b|premier league|champions league|rebounds|points per/.test(s)) return "sports";
  if (/\bcpi\b|inflation|\bfomc\b|\bfed\b|rate (cut|hike|decision)|jobs report|unemployment|jobless|payroll|\bgdp\b|interest rate|recession|kxfed|kxcpi/.test(s)) return "econ";
  if (/bitcoin|ethereum|\bbtc\b|\beth\b|\bspx\b|s&p ?500|nasdaq|price of|above \$|below \$|up or down/.test(s)) return "cryptoprice";
  if (/prime minister|\bpresident\b|election|drop out|resign|cabinet|nominee|chancellor|parliament|government|\bcoup\b|impeach|governor|senate|congress|\bmayor\b|appointed/.test(s)) return "political";
  if (/\bwar\b|invade|enter iran|\bstrike\b|ceasefire|hormuz|missile|nuclear|maduro|hostage|sanction|troops|military|annex|\bborder\b|airstrike|occupy/.test(s)) return "geopolitical";
  if (/\bceo\b|merger|acquisition|earnings|\bipo\b|bankruptcy|layoffs|\bfda\b|approval|recall|guidance|acquire/.test(s)) return "corporate";
  return "other";
}
const INSIDER_TOPICS = new Set(["political", "geopolitical", "corporate", "econ"]);

/* ------------------------------------------------- z-score helpers (measured)
 * Population mean / standard deviation, then z-scores from real on-chain fills.
 * This is the same construction as the informed-trading screen: a wallet's
 * anomaly is measured relative to the distribution it sits in, not in raw $. */
function zStat(vals) {
  const n = vals.length; if (n < 2) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  return { mean, sd, n };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Pull recent on-chain fills for one market (by conditionId) and aggregate per
// wallet: buy USDC, sell USDC, and buy USDC in the final 48h. Then compute the
// real cross-sectional bet-size z-score for the most anomalous qualifying
// wallet, plus its late-buy fraction, directional concentration, and (via a
// second call) its within-trader bet-size z-score across its other markets.
async function enrichMarket(cond) {
  const trades = [];
  let offset = 0, pages = 0;
  do {
    const d = await getJSON(
      "https://data-api.polymarket.com/trades?market=" + encodeURIComponent(cond) + "&limit=500&offset=" + offset,
      { timeout: 6000 }
    ).catch(() => null);
    const arr = Array.isArray(d) ? d : (d && (d.data || d.trades)) || [];
    if (!arr.length) break;
    trades.push(...arr); offset += arr.length; pages++;
  } while (trades.length < 700 && pages < 2);
  if (trades.length < 20) return null;

  const maxTs = trades.reduce((mx, t) => Math.max(mx, num(t.timestamp)), 0);
  const lateCut = maxTs - 48 * 3600;            // final-48h window, per the screen
  const W = {};
  trades.forEach((t) => {
    const w = t.proxyWallet; if (!w) return;
    const usd = num(t.size) * num(t.price); if (!usd) return;
    const o = W[w] || (W[w] = { buy: 0, sell: 0, late: 0 });
    if (String(t.side || "").toUpperCase() === "SELL") { o.sell += usd; }
    else { o.buy += usd; if (num(t.timestamp) >= lateCut) o.late += usd; }
  });
  const wallets = Object.keys(W);
  const buys = wallets.map((w) => W[w].buy).filter((v) => v > 0);
  if (buys.length < 3) return null;              // need a reference distribution
  const st = zStat(buys); if (!st || st.sd <= 0) return null;

  // most anomalous wallet that cleared the $500 minimum buy
  let best = null, bestZ = -Infinity;
  wallets.forEach((w) => {
    const b = W[w].buy; if (b < 500) return;
    const z = (b - st.mean) / st.sd;
    if (z > bestZ) { bestZ = z; best = w; }
  });
  if (!best) return null;
  const o = W[best];
  const zCross = clamp(bestZ, 0, 20);
  const lateFrac = o.buy > 0 ? clamp(o.late / o.buy, 0, 1) : 0;
  const dirScore = o.buy > 0 ? clamp(1 - o.sell / o.buy, 0, 1) : 0;

  // within-trader: this wallet's bet size here vs. its own bets in other markets
  let zWithin = 0;
  try {
    const d = await getJSON(
      "https://data-api.polymarket.com/trades?user=" + encodeURIComponent(best) + "&limit=500",
      { timeout: 6000 }
    ).catch(() => null);
    const arr = Array.isArray(d) ? d : (d && (d.data || d.trades)) || [];
    const perM = {};
    arr.forEach((t) => {
      const m = t.conditionId; if (!m) return;
      if (String(t.side || "").toUpperCase() === "SELL") return;
      perM[m] = (perM[m] || 0) + num(t.size) * num(t.price);
    });
    const vals = Object.values(perM).filter((v) => v > 0);
    if (vals.length >= 2) {
      const ws = zStat(vals);
      if (ws && ws.sd > 0) zWithin = clamp((o.buy - ws.mean) / ws.sd, 0, 12);
    }
  } catch (_) {}

  return {
    computed: true, nWallets: buys.length,
    wallet: best.slice(0, 6) + "…" + best.slice(-4),
    buyUsd: Math.round(o.buy),
    zCross: +zCross.toFixed(2), zWithin: +zWithin.toFixed(2),
    lateFrac: +lateFrac.toFixed(3), dirScore: +dirScore.toFixed(3),
  };
}

async function polymarket() {
  const out = [];   // { cond, a } so we can attach measured signals after
  // Active markets ranked by 24h volume (Gamma API, public).
  const markets = await getJSON(
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=250&order=volume24hr&ascending=false"
  ).catch(() => []);
  (Array.isArray(markets) ? markets : []).forEach((m, i) => {
    const vol = num(m.volume24hr || m.volume_24hr || m.volume24Hr);
    const liq = num(m.liquidity || m.liquidityNum || m.liquidityClob);
    const q = (m.question || m.title || m.slug || "Market").toString().slice(0, 90);
    const tp = topic(q);
    if (!INSIDER_TOPICS.has(tp)) return;          // skip sports / crypto-price / other
    if (vol < 50000) return;                       // needs real money behind it
    const cond = m.conditionId || null;
    // Pre-event price-move detector (the strongest signal): a sharp 1h move on a
    // market that turns on nonpublic information can be front-running the wire.
    const ch = num(m.oneHourPriceChange);
    if (Math.abs(ch) >= 0.12) {
      out.push({ cond, a: alert({
        id: "pm-move-" + (m.id || i), ts: hhmm(), platform: "polymarket", market: q,
        detector: "lead", sev: Math.abs(ch) >= 0.25 ? "high" : "med",
        metric: (ch >= 0 ? "+" : "") + Math.round(ch * 100) + "c in 1h  ($" + Math.round(vol / 1000) + "k vol)  [" + tp + "]",
      }) });
    }
    // Volume-to-liquidity spike on a thin niche book.
    if (liq >= 5000) {
      const ratio = vol / liq;
      if (ratio >= 6) {
        out.push({ cond, a: alert({
          id: "pm-vl-" + (m.id || i), ts: hhmm(), platform: "polymarket", market: q,
          detector: "vol_liq", sev: (ratio >= 15 || (vol >= 400000 && liq < 30000)) ? "high" : "med",
          metric: "vol/liq " + ratio.toFixed(0) + "x  ($" + Math.round(vol / 1000) + "k / $" + Math.round(liq / 1000) + "k)  [" + tp + "]",
        }) });
      }
    }
  });
  // Large single fills on insider-relevant markets (Data API). The firehose is
  // mostly tiny crypto-bot trades, so we scan deeper and topic-filter. usd = shares*price.
  const trades = await getJSON("https://data-api.polymarket.com/trades?limit=500").catch(() => []);
  const whales = {};
  (Array.isArray(trades) ? trades : []).forEach((t, i) => {
    const usd = num(t.size) * num(t.price);
    const title = (t.title || t.eventSlug || t.slug || "Market").toString().slice(0, 90);
    const tp = topic(title);
    if (usd >= 10000 && INSIDER_TOPICS.has(tp)) {
      const key = title + "|" + (t.side || "");
      if (!whales[key] || usd > whales[key].usd) {
        whales[key] = { usd, title, tp, side: t.side, hash: t.transactionHash || i, cond: t.conditionId || null };
      }
    }
  });
  Object.values(whales).forEach((w) => out.push({ cond: w.cond, a: alert({
    id: "pm-whale-" + w.hash, ts: hhmm(), platform: "polymarket", market: w.title,
    detector: "vacuum", sev: w.usd >= 50000 ? "high" : "med",
    metric: "$" + Math.round(w.usd / 1000) + "k fill" + (w.side ? " (" + String(w.side).toLowerCase() + ")" : "") + "  [" + w.tp + "]",
  }) }));

  // ---- measured z-score enrichment on the flagged markets ----
  // Cap at 6 markets (high-severity first) to stay inside the time budget; each
  // pulls real fills and computes the screen's z-scores from them.
  const order = out.slice().sort((a, b) => (b.a.sev === "high" ? 1 : 0) - (a.a.sev === "high" ? 1 : 0));
  const conds = [];
  order.forEach((o) => { if (o.cond && conds.indexOf(o.cond) === -1 && conds.length < 6) conds.push(o.cond); });
  const measured = {};
  await Promise.all(conds.map(async (cond) => {
    try { const sig = await enrichMarket(cond); if (sig) measured[cond] = sig; } catch (_) {}
  }));
  out.forEach((o) => { if (o.cond && measured[o.cond]) o.a.signals = measured[o.cond]; });

  return out.map((o) => o.a).slice(0, 50);
}

/* ----------------------------------------------------------------- Kalshi -- */
function kalshiHeaders(method, path) {
  const keyId = process.env.KALSHI_KEY_ID, pk = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !pk) return {}; // public market data works unauthenticated
  try {
    const ts = Date.now().toString();
    const msg = ts + method + path;
    const sig = crypto.sign("sha256", Buffer.from(msg), {
      key: pk, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString("base64");
    return { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts };
  } catch (_) { return {}; }
}
async function kalshi() {
  const alerts = [];
  const base = "https://api.elections.kalshi.com";
  // Kalshi can't sort markets by activity, so page through events in the
  // insider-relevant categories, collect every nested market, then rank by
  // 24h volume ourselves and surface the most active.
  const CATS = /econom|politic|world|financ|elect|climate|company|companies|social/i;
  const collected = [];
  let cursor = null, pages = 0;
  do {
    const url = base + "/trade-api/v2/events?limit=200&status=open&with_nested_markets=true" + (cursor ? "&cursor=" + cursor : "");
    const d = await getJSON(url, { headers: kalshiHeaders("GET", "/trade-api/v2/events") }).catch(() => null);
    if (!d) break;
    (d.events || d.data || []).forEach((ev) => {
      const cat = String(ev.category || "");
      if (!CATS.test(cat)) return;
      const evTitle = String(ev.title || ev.sub_title || "");
      (ev.markets || []).forEach((m) => {
        const vol = num(m.volume_24h_fp || m.volume_24h);
        if (vol < 200) return;
        collected.push({ vol, oi: num(m.open_interest_fp || m.open_interest), ticker: m.ticker, cat, title: (evTitle || m.title || m.yes_sub_title || m.ticker || "Market").toString().slice(0, 90) });
      });
    });
    cursor = d.cursor; pages++;
  } while (cursor && pages < 3);

  // Flag on CHURN (24h volume relative to standing open interest), not raw
  // volume — a popular market with huge OI and modest daily turnover is calm,
  // not suspicious. A high vol/OI ratio is the unusual-burst signal.
  collected.forEach((m, i) => {
    if (m.oi <= 0 || m.vol < 1000) return;     // need standing positions + real activity
    const ratio = m.vol / m.oi;
    if (ratio < 1.5) return;                    // only genuine churn spikes
    const sev = ratio >= 3 ? "high" : "med";
    alerts.push(alert({
      id: "k-vl-" + (m.ticker || i), ts: hhmm(), platform: "kalshi", market: m.title,
      detector: "vol_liq", sev,
      metric: "vol/OI " + ratio.toFixed(1) + "x  (" + Math.round(m.vol).toLocaleString() + " / " + Math.round(m.oi).toLocaleString() + " contracts)  [" + m.cat + "]",
    }));
  });
  alerts.sort((a, b) => (b.sev === "high" ? 1 : 0) - (a.sev === "high" ? 1 : 0));
  return alerts.slice(0, 15);
}

/* ------------------------------------------------------------------ debug -- */
// /api/surveillance/feed?debug=1 — returns the RAW shape of each upstream API
// (counts + field names + one sample) so detector field-mapping can be fixed
// without guessing. Read-only, public data; never returns the Kalshi key.
async function diagnose() {
  const o = {};
  try {
    const d = await getJSON("https://api.elections.kalshi.com/trade-api/v2/markets?limit=20&status=open",
      { headers: kalshiHeaders("GET", "/trade-api/v2/markets") });
    const arr = (d && (d.markets || d.data)) || [];
    o.kalshi = { ok: true, count: arr.length, keys: arr[0] ? Object.keys(arr[0]) : [], sample: arr[0] || null };
  } catch (e) { o.kalshi = { ok: false, error: e.message }; }
  try {
    const d = await getJSON("https://api.elections.kalshi.com/trade-api/v2/events?limit=30&status=open&with_nested_markets=true",
      { headers: kalshiHeaders("GET", "/trade-api/v2/events") });
    const arr = (d && (d.events || d.data)) || [];
    o.kalshiEvents = {
      ok: true, count: arr.length,
      keys: arr[0] ? Object.keys(arr[0]) : [],
      categories: [...new Set(arr.map((e) => e.category).filter(Boolean))],
      sampleTitles: arr.slice(0, 8).map((e) => (e.title || "") + " [" + (e.category || "") + "]"),
      sampleMarketKeys: arr[0] && arr[0].markets && arr[0].markets[0] ? Object.keys(arr[0].markets[0]) : [],
    };
  } catch (e) { o.kalshiEvents = { ok: false, error: e.message }; }
  try {
    const d = await getJSON("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&order=volume24hr&ascending=false");
    const arr = Array.isArray(d) ? d : (d.data || []);
    o.pmMarkets = { ok: true, count: arr.length, keys: arr[0] ? Object.keys(arr[0]) : [], sampleTitle: arr[0] && (arr[0].question || arr[0].title) };
  } catch (e) { o.pmMarkets = { ok: false, error: e.message }; }
  try {
    const d = await getJSON("https://data-api.polymarket.com/trades?limit=5");
    const arr = Array.isArray(d) ? d : (d.data || d.trades || []);
    o.pmTrades = { ok: true, count: arr.length, keys: arr[0] ? Object.keys(arr[0]) : [], sample: arr[0] || null };
  } catch (e) { o.pmTrades = { ok: false, error: e.message }; }
  return o;
}

/* ------------------------------------------------------------------- main -- */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if ((req.query && (req.query.debug === "1" || req.query.debug === "true")) || String(req.url || "").includes("debug=1")) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(await diagnose());
    return;
  }

  const sources = { polymarket: "ok", kalshi: process.env.KALSHI_KEY_ID ? "ok(auth)" : "ok(public)" };
  let pm = [], k = [];
  try { pm = await polymarket(); } catch (e) { sources.polymarket = "error: " + e.message; }
  try { k = await kalshi(); } catch (e) { sources.kalshi = "error: " + e.message; }

  const alerts = [...k, ...pm].sort((a, b) => (a.sev === b.sev ? 0 : a.sev === "high" ? -1 : 1));
  const zscored = alerts.filter((a) => a.signals && a.signals.computed).length;
  if (sources.polymarket === "ok") sources.polymarket = "ok(" + zscored + " z-scored)";
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    live: alerts.length > 0,
    sources,
    alerts,
  });
};
