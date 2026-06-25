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
async function getText(url, opts) {
  const to = withTimeout((opts && opts.timeout) || 6000);
  try {
    const r = await fetch(url, { headers: (opts && opts.headers) || {}, signal: to.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { to.done(); }
}
function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/<[^>]+>/g, "").trim();
}
const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
function alert(o) {
  return {
    id: o.id, ts: o.ts, platform: o.platform, market: o.market, detector: o.detector,
    sev: o.sev, metric: o.metric, spark: o.spark || null, metrics: o.metrics || null,
    note: o.note || NOTE[o.detector] || "", gap: o.gap || GAP[o.detector] || "Anomalous, not proof of a violation.",
  };
}
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function hhmm() { return new Date().toISOString().slice(11, 16) + " UTC"; }

/* --------------------------------------------------------- topic classifier -
 * Insider trading only makes sense where the OUTCOME turns on nonpublic
 * information: geopolitics, government/political decisions, leakable economic
 * data, and corporate events. Sports, esports, and crypto/index price levels
 * are efficient + public, so we drop them — that is where the noise was. */
function topic(text) {
  const s = String(text || "").toLowerCase();
  if (/\bvs\.?\b|spread:|o\/u|over\/under|moneyline|win on \d{4}-|exact score|\d\s*-\s*\d|world cup|counter-?strike|esports|goalscorer|glove|knockout stage|advance to|\bwnba\b|\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|\bufc\b|\bf1\b|halftime|to score|\bbo\d\b|premier league|champions league|rebounds|points per/.test(s)) return "sports";
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

// On-chain READOUT for one market (by conditionId), measured from the recent
// fills the public Data API exposes. We deliberately compute only what a recent
// window can support honestly: per-wallet BUY concentration (robust to
// complement-routing fill splits because we aggregate per wallet) and a
// recent-flow cross-sectional z-score for the top buyer.
//
// We do NOT try to reconstruct the paper's late-buy fraction, profit, or
// within-trader z-scores here: those require COMPLETE trade history and a
// RESOLVED outcome (the paper builds them from full Dune data offline). From a
// recent window they degrade to artifacts (late-fraction pins to ~1, sells are
// undercounted), so they are left to the documented-case demonstrations.
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
  } while (trades.length < 1000 && pages < 2);
  if (trades.length < 25) return null;

  // BUY and SELL USDC per wallet (aggregate fills -> one figure per wallet)
  const buyByWallet = {}; let totalBuy = 0, totalSell = 0;
  trades.forEach((t) => {
    const w = t.proxyWallet; if (!w) return;
    const usd = num(t.size) * num(t.price); if (!usd) return;
    if (String(t.side || "").toUpperCase() === "SELL") { totalSell += usd; return; }
    buyByWallet[w] = (buyByWallet[w] || 0) + usd; totalBuy += usd;
  });
  const wallets = Object.keys(buyByWallet);
  const buys = wallets.map((w) => buyByWallet[w]).filter((v) => v > 0);
  if (buys.length < 5) return null;                 // need a reference distribution
  const total = buys.reduce((a, b) => a + b, 0);
  const st = zStat(buys); if (!st || st.sd <= 0) return null;

  let best = null, bestBuy = 0;
  wallets.forEach((w) => { if (buyByWallet[w] > bestBuy) { bestBuy = buyByWallet[w]; best = w; } });
  if (bestBuy < 500) return null;

  const recentZ = clamp((bestBuy - st.mean) / st.sd, 0, 20);   // windowed cross-sectional z
  const topShare = total > 0 ? clamp(bestBuy / total, 0, 1) : 0;
  // VPIN-style order-flow imbalance: |buy-sell| / (buy+sell) over the window
  const flow = totalBuy + totalSell;
  const imbalance = flow > 0 ? clamp(Math.abs(totalBuy - totalSell) / flow, 0, 1) : 0;
  // Herfindahl concentration of buying across wallets (1 = one wallet, ~0 = diffuse)
  const herfindahl = total > 0 ? clamp(buys.reduce((a, b) => a + (b / total) * (b / total), 0), 0, 1) : 0;
  return {
    computed: true, windowed: true, nTrades: trades.length, nWallets: buys.length,
    wallet: best.slice(0, 6) + "…" + best.slice(-4),
    topBuyUsd: Math.round(bestBuy),
    recentZ: +recentZ.toFixed(2), topShare: +topShare.toFixed(3),
    imbalance: +imbalance.toFixed(3), herfindahl: +herfindahl.toFixed(3),
  };
}

/* ---------------------------------------- price-history shock σ (Polymarket)
 * Pull the market's CLOB price series, read it in LOG-ODDS space, and compute
 * the biggest single-step move as a z-score against the series' own volatility
 * — the lightweight "rolling z-score" multi-scale shock the event-aligned model
 * calls for. Returns true before/after prices and the move's timestamp too. */
// Shared: a price series [{t (unix s), p (0..1)}] -> the SUSTAINED run-up (the
// early level vs the current level, in log-odds), standardised by the series'
// own step volatility (Keown-Pinkerton style). Using the sustained move rather
// than a single biggest step rejects transient thin-market spikes that revert.
function logitShockFromSeries(pts) {
  if (!Array.isArray(pts)) return null;
  pts = pts.filter((x) => x && x.p > 0 && x.p < 1 && x.t > 0).sort((a, b) => a.t - b.t);
  if (pts.length < 8) return null;
  const clp = (p) => clip(p, 0.03, 0.97);   // near 0/1 a one-tick wiggle would otherwise explode the logit
  const L = (p) => Math.log(clp(p) / (1 - clp(p)));
  const lg = pts.map((x) => L(x.p));
  const r = []; for (let i = 1; i < lg.length; i++) r.push(lg[i] - lg[i - 1]);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) * (b - mean), 0) / r.length);
  if (!(sd > 0)) return null;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const nE = Math.max(3, Math.floor(pts.length * 0.25)), nL = Math.max(3, Math.floor(pts.length * 0.15));
  const early = med(pts.slice(0, nE).map((x) => x.p));   // baseline level
  const late = med(pts.slice(-nL).map((x) => x.p));      // current sustained level
  const runMove = Math.abs(L(late) - L(early));
  let shockSigma = clip(runMove / sd, 0, 12);
  if (Math.abs(late - early) < 0.03) shockSigma = Math.min(shockSigma, 1.2);   // a tiny sustained move is not a run-up
  return {
    shockSigma: +shockSigma.toFixed(2),
    pBefore: +early.toFixed(3), pAfter: +late.toFixed(3),
    windowH: Math.min(168, Math.max(1, Math.round((pts[pts.length - 1].t - pts[0].t) / 3600))),
    moveMs: pts[pts.length - 1].t * 1000,
  };
}
async function priceHistory(tokenId) {
  if (!tokenId) return null;
  const d = await getJSON(
    "https://clob.polymarket.com/prices-history?market=" + encodeURIComponent(tokenId) + "&interval=1w&fidelity=60",
    { timeout: 6000 }
  ).catch(() => null);
  const hist = d && (d.history || d.data || (Array.isArray(d) ? d : null));
  if (!Array.isArray(hist)) return null;
  return logitShockFromSeries(hist.map((x) => ({ t: num(x.t || x.timestamp), p: num(x.p || x.price) })));
}
// Kalshi price anomaly from authenticated candlesticks (prices in cents or dollars).
async function kalshiCandles(series, ticker) {
  if (!series || !ticker) return null;
  const end = Math.floor(Date.now() / 1000), start = end - 7 * 86400;
  const path = "/trade-api/v2/series/" + series + "/markets/" + ticker + "/candlesticks";
  const d = await getJSON(
    "https://api.elections.kalshi.com" + path + "?start_ts=" + start + "&end_ts=" + end + "&period_interval=60",
    { headers: kalshiHeaders("GET", path), timeout: 6000 }
  ).catch(() => null);
  const cs = d && (d.candlesticks || d.data);
  if (!Array.isArray(cs)) return null;
  const pts = cs.map((c) => {
    const pr = c.price || {};
    let raw = pr.mean_dollars != null ? pr.mean_dollars
      : (pr.close_dollars != null ? pr.close_dollars : (c.yes_bid && c.yes_bid.close_dollars));
    let p = num(raw); if (p > 1) p = p / 100;   // values are already dollars (0..1); guard if cents
    return { t: num(c.end_period_ts || c.ts), p };
  });
  return logitShockFromSeries(pts);
}

/* ------------------------------------------------ public-news explanation (E)
 * Keyless: query Google News RSS for the market's subject, then compare the
 * timing of relevant headlines to the price move. News AROUND the move →
 * "explained" (less suspicious). The move BEFORE the first relevant headline →
 * pre-event (front-running the wire). Nothing relevant → unknown (not cleared). */
function newsQuery(t) {
  let s = String(t || "").replace(/[?]+/g, " ").trim();
  s = s.replace(/^(will|does|is|are|can|did|has|have|the|a|an)\s+/i, "");
  s = s.replace(/\s+(by|in|before|on|this|next)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|20\d\d|\d).*$/i, "");
  return s.replace(/\s+/g, " ").trim();
}
async function newsCheck(query, moveMs) {
  if (!query || query.length < 3) return null;
  const xml = await getText(
    "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en",
    { headers: { "user-agent": "Mozilla/5.0 (compatible; surveillance/1.0)" }, timeout: 6000 }
  ).catch(() => null);
  if (!xml) return null;
  const items = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) && items.length < 14) {
    const blk = m[1];
    const title = decodeEntities((blk.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const pub = (blk.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
    const src = decodeEntities((blk.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "");
    const ts = pub ? Date.parse(pub) : NaN;
    if (title) items.push({ title, src, ts });
  }
  if (!items.length) return { explained: null };
  const qwords = query.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  const rel = items.filter((it) => { const h = it.title.toLowerCase(); return qwords.some((w) => h.includes(w)); }).filter((it) => isFinite(it.ts));
  if (!rel.length) return { explained: null };
  rel.sort((a, b) => a.ts - b.ts);
  const mv = moveMs || Date.now();
  const near = rel.filter((it) => Math.abs(it.ts - mv) <= 24 * 3600 * 1000);
  if (near.length) {
    const top = near.slice().sort((a, b) => Math.abs(a.ts - mv) - Math.abs(b.ts - mv))[0];
    return { explained: true, headline: top.title.slice(0, 140), source: top.src || "news", catalyst: top.title.slice(0, 80), leadH: null };
  }
  const after = rel.filter((it) => it.ts > mv);
  if (after.length) {
    const first = after[0]; const leadH = Math.round((first.ts - mv) / 3600000);
    if (leadH >= 1 && leadH <= 240) {
      return { explained: false, headline: first.title.slice(0, 140), source: first.src || "news", catalyst: first.title.slice(0, 80), leadH };
    }
  }
  return { explained: null };
}

async function polymarket() {
  const out = [];   // { cond, a } so we can attach measured signals after
  const condMeta = {};   // cond -> { tokenId, title } for price-history + news
  // Active markets ranked by 24h volume (Gamma API, public).
  const markets = await getJSON(
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=250&order=volume24hr&ascending=false"
  ).catch(() => []);
  (Array.isArray(markets) ? markets : []).forEach((m, i) => {
    const vol = num(m.volume24hr || m.volume_24hr || m.volume24Hr);
    const liq = num(m.liquidity || m.liquidityNum || m.liquidityClob);
    const q = (m.question || m.title || m.slug || "Market").toString().slice(0, 90);
    const tp = topic(q);
    // Scan every category EXCEPT the two that can't host insider trading: pure
    // crypto price-levels, and individual sports game-lines (a game's result is
    // decided on the field — there is no material nonpublic information to leak).
    if (tp === "cryptoprice" || tp === "sports") return;
    if (vol < 75000) return;                       // real money behind it
    const cond = m.conditionId || null;
    // YES CLOB token id (for price history) + title (for news), keyed by market
    if (cond && !condMeta[cond]) {
      let tokenId = null;
      if (m.clobTokenIds) { try { const ct = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds; tokenId = ct && ct[0]; } catch (_) {} }
      condMeta[cond] = { tokenId, title: q };
    }
    // current YES price -> before/after for the event-aligned score
    let price = num(m.lastTradePrice);
    if (!price && m.outcomePrices) { try { const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices; price = num(op && op[0]); } catch (_) {} }
    // Price-move finder: a sharp recent move on a market that turns on nonpublic
    // information can be front-running the wire. Gamma exposes oneDayPriceChange
    // (there is no 1h field); the real shock σ is then measured from price
    // history for the flagged set. Skip deep longshots where a 1c tick is noise.
    const ch = num(m.oneDayPriceChange);
    if (Math.abs(ch) >= 0.15 && price > 0.05 && price < 0.95) {
      const pA = clip(price, 0.01, 0.99);
      const pB = clip(pA - ch, 0.01, 0.99);
      out.push({ cond, a: alert({
        id: "pm-move-" + (m.id || i), ts: hhmm(), platform: "polymarket", market: q,
        detector: "lead", sev: Math.abs(ch) >= 0.30 ? "high" : "med",
        metric: (ch >= 0 ? "+" : "") + Math.round(ch * 100) + "c in 24h  ($" + Math.round(vol / 1000) + "k vol)  [" + tp + "]",
        metrics: { category: tp, pBefore: pB, pAfter: pA, windowH: 24, volUsd: Math.round(vol), liqUsd: liq ? Math.round(liq) : null, volRatio: liq ? +(vol / liq).toFixed(1) : null },
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
          metrics: { category: tp, volUsd: Math.round(vol), liqUsd: Math.round(liq), volRatio: +ratio.toFixed(1) },
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
    if (usd >= 12000 && tp !== "cryptoprice" && tp !== "sports") {
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
    metrics: { category: w.tp, volUsd: Math.round(w.usd) },
  }) }));

  // ---- enrichment on the flagged markets (cap 6, high-severity first) ----
  // Each market gets: measured on-chain concentration, a real price-history
  // shock σ in log-odds, and a public-news check (E / pre-event timing).
  const order = out.slice().sort((a, b) => (b.a.sev === "high" ? 1 : 0) - (a.a.sev === "high" ? 1 : 0));
  const conds = [];
  order.forEach((o) => { if (o.cond && conds.indexOf(o.cond) === -1 && conds.length < 6) conds.push(o.cond); });
  const enrich = {};
  await Promise.all(conds.map(async (cond) => {
    const meta = condMeta[cond] || {};
    try {
      const [sig, ph] = await Promise.all([
        enrichMarket(cond).catch(() => null),
        priceHistory(meta.tokenId).catch(() => null),
      ]);
      const news = await newsCheck(newsQuery(meta.title || ""), ph && ph.moveMs).catch(() => null);
      enrich[cond] = { sig, ph, news };
    } catch (_) {}
  }));
  out.forEach((o) => {
    const e = o.cond && enrich[o.cond]; if (!e) return;
    if (e.sig) o.a.signals = e.sig;
    if (e.ph) o.a.metrics = Object.assign({}, o.a.metrics, { shockSigma: e.ph.shockSigma, pBefore: e.ph.pBefore, pAfter: e.ph.pAfter, windowH: e.ph.windowH });
    if (e.news) o.a.metrics = Object.assign({}, o.a.metrics, {
      explained: e.news.explained, catalyst: e.news.catalyst || null,
      leadH: e.news.leadH != null ? e.news.leadH : null, headline: e.news.headline || null, newsSource: e.news.source || null,
    });
  });

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
  const base = "https://api.elections.kalshi.com";
  // Page through open events across EVERY category, collect nested markets.
  const collected = [];
  let cursor = null, pages = 0;
  do {
    const url = base + "/trade-api/v2/events?limit=200&status=open&with_nested_markets=true" + (cursor ? "&cursor=" + cursor : "");
    const d = await getJSON(url, { headers: kalshiHeaders("GET", "/trade-api/v2/events") }).catch(() => null);
    if (!d) break;
    (d.events || d.data || []).forEach((ev) => {
      const cat = String(ev.category || "Other");
      if (/crypto|sport/i.test(cat)) return;     // price-level + game-outcome markets aren't insider-tradeable
      const series = ev.series_ticker || "";
      const evTitle = String(ev.title || ev.sub_title || "");
      (ev.markets || []).forEach((m) => {
        const vol = num(m.volume_24h_fp || m.volume_24h);
        const oi = num(m.open_interest_fp || m.open_interest);
        if (vol < 1000 || oi < 200) return;      // real activity + a standing book
        collected.push({ vol, oi, ratio: vol / oi, ticker: m.ticker, series, cat,
          title: (evTitle || m.title || m.yes_sub_title || m.ticker || "Market").toString().slice(0, 100) });
      });
    });
    cursor = d.cursor; pages++;
  } while (cursor && pages < 4);

  // Rank by churn (24h volume / standing open interest) across all categories;
  // enrich the top movers with a real price-history shock σ (candlesticks) and
  // a public-news check, the same event-aligned signals as Polymarket.
  const top = collected.filter((m) => m.ratio >= 1.3).sort((a, b) => b.ratio - a.ratio).slice(0, 12);
  await Promise.all(top.map(async (m) => {
    try {
      const cd = await kalshiCandles(m.series, m.ticker).catch(() => null);
      const nw = await newsCheck(newsQuery(m.title), cd && cd.moveMs).catch(() => null);
      m._cd = cd; m._nw = nw;
    } catch (_) {}
  }));

  return top.map((m, i) => {
    const sev = m.ratio >= 3 ? "high" : "med";
    const metrics = { category: m.cat, contracts: Math.round(m.vol), oi: Math.round(m.oi), volRatio: +m.ratio.toFixed(1) };
    if (m._cd) { metrics.shockSigma = m._cd.shockSigma; metrics.pBefore = m._cd.pBefore; metrics.pAfter = m._cd.pAfter; metrics.windowH = m._cd.windowH; }
    if (m._nw) { metrics.explained = m._nw.explained; metrics.catalyst = m._nw.catalyst || null; metrics.leadH = m._nw.leadH != null ? m._nw.leadH : null; metrics.headline = m._nw.headline || null; metrics.newsSource = m._nw.source || null; }
    return alert({
      id: "k-vl-" + (m.ticker || i), ts: hhmm(), platform: "kalshi", market: m.title,
      detector: "vol_liq", sev,
      metric: "vol/OI " + m.ratio.toFixed(1) + "x  (" + Math.round(m.vol).toLocaleString() + " / " + Math.round(m.oi).toLocaleString() + " contracts)  [" + m.cat + "]",
      metrics,
    });
  });
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
  // price-history + news probes (the two new enrichment sources)
  try {
    const d = await getJSON("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&order=volume24hr&ascending=false");
    const arr = Array.isArray(d) ? d : (d.data || []); const m0 = arr[0] || {};
    let tok = null; if (m0.clobTokenIds) { try { const ct = typeof m0.clobTokenIds === "string" ? JSON.parse(m0.clobTokenIds) : m0.clobTokenIds; tok = ct && ct[0]; } catch (_) {} }
    const ph = await priceHistory(tok).catch((e) => ({ error: String(e && e.message || e) }));
    const nq = newsQuery(m0.question || m0.title || "");
    const news = await newsCheck(nq, ph && ph.moveMs).catch((e) => ({ error: String(e && e.message || e) }));
    o.priceHistory = { tokenSeen: !!tok, result: ph };
    o.news = { query: nq, result: news };
  } catch (e) { o.enrichProbe = { error: e.message }; }
  // Kalshi candlestick probe: show the raw shape so the parser can be fixed.
  try {
    const d = await getJSON("https://api.elections.kalshi.com/trade-api/v2/events?limit=40&status=open&with_nested_markets=true",
      { headers: kalshiHeaders("GET", "/trade-api/v2/events") });
    const evs = (d && (d.events || d.data)) || [];
    const ev = evs.find((e) => e.series_ticker && e.markets && e.markets.length && num(e.markets[0].open_interest_fp || e.markets[0].open_interest) > 0);
    if (!ev) { o.kalshiCandles = { note: "no eligible event found" }; }
    else {
      const tk = ev.markets[0].ticker;
      const path = "/trade-api/v2/series/" + ev.series_ticker + "/markets/" + tk + "/candlesticks";
      const end = Math.floor(Date.now() / 1000), start = end - 7 * 86400;
      const raw = await getJSON("https://api.elections.kalshi.com" + path + "?start_ts=" + start + "&end_ts=" + end + "&period_interval=60",
        { headers: kalshiHeaders("GET", path) }).catch((e) => ({ error: String(e && e.message || e) }));
      o.kalshiCandles = {
        series: ev.series_ticker, ticker: tk,
        rawError: raw && raw.error || null,
        rawKeys: raw && !raw.error ? Object.keys(raw) : null,
        count: raw && raw.candlesticks ? raw.candlesticks.length : null,
        sampleCandle: raw && raw.candlesticks ? raw.candlesticks[Math.max(0, raw.candlesticks.length - 1)] : null,
        parsed: await kalshiCandles(ev.series_ticker, tk).catch(() => null),
      };
    }
  } catch (e) { o.kalshiCandles = { error: e.message }; }
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
  // Run both collectors in parallel so the added price-history + news fetches
  // stay inside the function's time budget.
  const [pm, k] = await Promise.all([
    polymarket().catch((e) => { sources.polymarket = "error: " + e.message; return []; }),
    kalshi().catch((e) => { sources.kalshi = "error: " + e.message; return []; }),
  ]);

  const alerts = [...k, ...pm].sort((a, b) => (a.sev === b.sev ? 0 : a.sev === "high" ? -1 : 1));
  const enriched = alerts.filter((a) => a.signals && a.signals.computed).length;
  if (sources.polymarket === "ok") sources.polymarket = "ok(" + enriched + " on-chain)";
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    live: alerts.length > 0,
    sources,
    alerts,
  });
};
