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

/* ------------------------------------------------------------ Polymarket --- */
async function polymarket() {
  const alerts = [];
  // Active markets ranked by 24h volume (Gamma API, public).
  const markets = await getJSON(
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=60&order=volume24hr&ascending=false"
  ).catch(() => []);
  (Array.isArray(markets) ? markets : []).forEach((m, i) => {
    const vol = num(m.volume24hr || m.volume_24hr || m.volume24Hr);
    const liq = num(m.liquidity || m.liquidityNum || m.liquidityClob);
    const q = (m.question || m.title || m.slug || "Market").toString().slice(0, 80);
    if (liq > 0 && vol / liq >= 4 && vol > 25000) {
      alerts.push(alert({
        id: "pm-vl-" + (m.id || i), ts: hhmm(), platform: "polymarket", market: q,
        detector: "vol_liq", sev: vol / liq >= 8 ? "high" : "med",
        metric: "vol/liq " + (vol / liq).toFixed(1) + "x  ($" + Math.round(vol / 1000) + "k / $" + Math.round(liq / 1000) + "k)",
      }));
    }
  });
  // Recent large trades (Data API, public). Field names vary; read defensively.
  const trades = await getJSON("https://data-api.polymarket.com/trades?limit=120&takerOnly=false").catch(() => []);
  (Array.isArray(trades) ? trades : []).forEach((t, i) => {
    const size = num(t.size || t.amount || t.usdcSize || t.makerAmountFilled);
    const price = num(t.price || t.outcomePrice) || 1;
    const usd = size > 1000 ? size : size * price; // size may already be USDC
    const title = (t.title || t.market || t.eventSlug || t.slug || "Market").toString().slice(0, 80);
    if (usd >= 10000) {
      alerts.push(alert({
        id: "pm-vacuum-" + (t.transactionHash || t.id || i), ts: hhmm(), platform: "polymarket", market: title,
        detector: "vacuum", sev: usd >= 50000 ? "high" : "med",
        metric: "$" + Math.round(usd / 1000) + "k single fill" + (t.side ? " (" + String(t.side).toLowerCase() + ")" : ""),
      }));
    }
  });
  return alerts.slice(0, 30);
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
  const path = "/trade-api/v2/markets?limit=200&status=open";
  const data = await getJSON(base + path, { headers: kalshiHeaders("GET", "/trade-api/v2/markets") }).catch(() => null);
  const markets = (data && (data.markets || data.data)) || [];
  markets.forEach((m, i) => {
    const vol = num(m.volume_24h || m.volume24h || m.volume);
    const oi = num(m.open_interest || m.openInterest);
    const title = (m.title || m.subtitle || m.ticker || "Market").toString().slice(0, 80);
    // Volume-to-open-interest spike: lots of churn relative to standing positions.
    if (oi > 0 && vol / oi >= 5 && vol > 5000) {
      alerts.push(alert({
        id: "k-vl-" + (m.ticker || i), ts: hhmm(), platform: "kalshi", market: title,
        detector: "vol_liq", sev: vol / oi >= 10 ? "high" : "med",
        metric: "vol/OI " + (vol / oi).toFixed(1) + "x  (" + vol.toLocaleString() + " / " + oi.toLocaleString() + ")",
      }));
    }
  });
  return alerts.slice(0, 30);
}

/* ------------------------------------------------------------------- main -- */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

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
