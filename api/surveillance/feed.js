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
  if (/\bcpi\b|inflation|\bfomc\b|fed (rate|meeting|cut|hike)|rate (cut|hike|decision)|jobs report|unemployment|jobless|payroll|\bgdp\b|interest rate/.test(s)) return "econ";
  if (/bitcoin|ethereum|\bbtc\b|\beth\b|\bspx\b|s&p ?500|nasdaq|price of|above \$|below \$|up or down/.test(s)) return "cryptoprice";
  if (/prime minister|\bpresident\b|election|drop out|resign|cabinet|nominee|chancellor|parliament|government|\bcoup\b|impeach|governor|senate|congress|\bmayor\b|appointed/.test(s)) return "political";
  if (/\bwar\b|invade|enter iran|\bstrike\b|ceasefire|hormuz|missile|nuclear|maduro|hostage|sanction|troops|military|annex|\bborder\b|airstrike|occupy/.test(s)) return "geopolitical";
  if (/\bceo\b|merger|acquisition|earnings|\bipo\b|bankruptcy|layoffs|\bfda\b|approval|recall|guidance|acquire/.test(s)) return "corporate";
  return "other";
}
const INSIDER_TOPICS = new Set(["political", "geopolitical", "corporate", "econ"]);

async function polymarket() {
  const alerts = [];
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
    if (!(liq >= 5000 && vol >= 50000)) return;   // ignore dust + quiet markets
    const ratio = vol / liq;
    if (ratio < 6) return;
    const sev = (ratio >= 15 || (vol >= 400000 && liq < 30000)) ? "high" : "med";
    alerts.push(alert({
      id: "pm-vl-" + (m.id || i), ts: hhmm(), platform: "polymarket", market: q,
      detector: "vol_liq", sev,
      metric: "vol/liq " + ratio.toFixed(0) + "x  ($" + Math.round(vol / 1000) + "k / $" + Math.round(liq / 1000) + "k)  [" + tp + "]",
    }));
  });
  // Recent large single fills (Data API, public). usd = shares * price.
  const trades = await getJSON("https://data-api.polymarket.com/trades?limit=100").catch(() => []);
  (Array.isArray(trades) ? trades : []).forEach((t, i) => {
    const shares = num(t.size || t.amount || t.makerAmountFilled);
    const price = num(t.price || t.outcomePrice);
    const usd = price > 0 && price <= 1 ? shares * price : num(t.usdcSize || t.size);
    const title = (t.title || t.market || t.eventSlug || t.slug || "Market").toString().slice(0, 90);
    const tp = topic(title);
    if (usd >= 20000 && INSIDER_TOPICS.has(tp)) {
      alerts.push(alert({
        id: "pm-whale-" + (t.transactionHash || t.id || i), ts: hhmm(), platform: "polymarket", market: title,
        detector: "vacuum", sev: usd >= 100000 ? "high" : "med",
        metric: "$" + Math.round(usd / 1000) + "k single fill" + (t.side ? " (" + String(t.side).toLowerCase() + ")" : "") + "  [" + tp + "]",
      }));
    }
  });
  return alerts.slice(0, 40);
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
  const path = "/trade-api/v2/markets?limit=1000&status=open";
  const data = await getJSON(base + path, { headers: kalshiHeaders("GET", "/trade-api/v2/markets") }).catch(() => null);
  const markets = (data && (data.markets || data.data)) || [];
  markets.forEach((m, i) => {
    const vol = num(m.volume_24h || m.volume24h || m.volume);
    const oi = num(m.open_interest || m.openInterest);
    const liq = num(m.liquidity);
    const title = (m.title || m.subtitle || m.yes_sub_title || m.ticker || "Market").toString().slice(0, 90);
    const tp = topic(title + " " + (m.ticker || ""));
    if (!INSIDER_TOPICS.has(tp)) return;          // only insider-relevant topics
    if (vol < 8000) return;                        // needs real money behind it
    // Churn vs standing positions; Kalshi OI runs closer to volume than
    // Polymarket liquidity, so the bar is lower than the Polymarket vol/liq one.
    const denom = oi > 0 ? oi : (liq > 0 ? liq : 0);
    if (!denom) return;
    const ratio = vol / denom;
    if (ratio < 2.5) return;
    const sev = ratio >= 5 ? "high" : "med";
    alerts.push(alert({
      id: "k-vl-" + (m.ticker || i), ts: hhmm(), platform: "kalshi", market: title,
      detector: "vol_liq", sev,
      metric: "vol/OI " + ratio.toFixed(1) + "x  (" + Math.round(vol).toLocaleString() + " / " + Math.round(denom).toLocaleString() + ")  [" + tp + "]",
    }));
  });
  return alerts.slice(0, 30);
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
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    live: alerts.length > 0,
    sources,
    alerts,
  });
};
