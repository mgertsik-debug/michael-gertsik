/* ============================================================================
 *  /api/surveillance/feed  —  live full-market surveillance scanner
 *  ---------------------------------------------------------------------------
 *  Server-side (holds the Kalshi key, dodges browser CORS). Two tiers, both on
 *  PUBLIC market data:
 *
 *    1. ENUMERATION — page through every open market on Polymarket (Gamma
 *       /events, nested markets + tags) and Kalshi (/events?with_nested_markets,
 *       category per event). For each market we capture the VERBATIM question, a
 *       link to the live market, its category, current probability, 24h volume
 *       and liquidity, and score it with a cheap run-up proxy + liquidity gate so
 *       EVERY market gets a preliminary suspicion index and is rankable.
 *
 *    2. DEEP ENRICHMENT — for the top-ranked markets (not low-liquidity), fetch
 *       price history / candlesticks / on-chain trades and compute the rigorous
 *       detectors from detectors.js (Keown-Pinkerton run-up, Kyle's λ + Amihud,
 *       VPIN, Herfindahl concentration) plus the news-context gate, then re-fuse.
 *
 *  Returns { generatedAt, live, cadence, coverage, sources, markets:[…], alerts }.
 *  `alerts` is a back-compat compact view of the flagged subset for the cron.
 *
 *  Env (optional): KALSHI_KEY_ID, KALSHI_PRIVATE_KEY  (read-only key).
 * ========================================================================== */
"use strict";

const crypto = require("crypto");
const D = require("./detectors.js");

/* ----------------------------------------------------------------- fetch -- */
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
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------- categories --
 * Both platforms are mapped into ONE canonical taxonomy of categories where an
 * insider-information edge is plausible (a party can hold material nonpublic
 * information about the outcome). Categories whose outcomes are decided in
 * public / on the field / by efficient price discovery — Sports, Crypto price
 * levels, Commodities, Climate & Weather, day-to-day index price bets, and
 * "mentions" — are EXCLUDED, because a trading anomaly there is noise, not a
 * leak. canonCat() reads a raw tag / Kalshi category / the question text and
 * returns { c: canonicalName, ex: true|false } or null when nothing matches. */
const DETECTABLE = ["Politics", "Elections", "Economy", "Finance", "Business", "World", "Tech & Science", "Culture", "Health"];
function canonCat(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return null;
  // --- excluded (efficient / public / physical outcomes) ---
  if (/\bsport|nfl|nba|wnba|mlb|nhl|\bufc\b|soccer|football|basketball|baseball|hockey|tennis|golf|\bf1\b|grand prix|\bmatch\b|\bgame\b|league|playoff|champions|\bcup\b|olympic|medal|goalscorer|moneyline|over\/under|to score/.test(s)) return { c: "Sports", ex: true };
  if (/crypto|bitcoin|\bbtc\b|ethereum|\beth\b|solana|\bsol\b|\bxrp\b|dogecoin|\bdefi\b|memecoin|\$?\bnft\b|token price|coin price/.test(s)) return { c: "Crypto", ex: true };
  if (/commodit|crude|\boil\b|\bwti\b|\bbrent\b|\bgold\b|silver|natural gas|\bgasoline\b|wheat|corn|copper/.test(s)) return { c: "Commodities", ex: true };
  if (/climate|weather|temperature|hottest|hurricane|rainfall|snowfall|\bel ni|drought/.test(s)) return { c: "Climate", ex: true };
  if (/\bmention|say the word|include the word|keyword/.test(s)) return { c: "Mentions", ex: true };
  // --- detectable (outcome can turn on nonpublic information) ---
  if (/election|midterm|primary|\bballot|electoral|turnout|swing state|popular vote/.test(s)) return { c: "Elections", ex: false };
  if (/econom|inflation|\bcpi\b|\bpce\b|\bfed\b|fomc|\bgdp\b|jobs report|payroll|unemploy|jobless|rate (cut|hike|decision)|interest rate|recession/.test(s)) return { c: "Economy", ex: false };
  if (/financ|s&p|\bspx\b|nasdaq|\bdow\b|treasury|\byield\b|\bvix\b|stock market|equit|\bbond\b|credit/.test(s)) return { c: "Finance", ex: false };
  if (/business|\bcompan|corporate|earnings|merger|acquisition|\bipo\b|\bceo\b|bankruptc|layoff|antitrust|guidance/.test(s)) return { c: "Business", ex: false };
  if (/\btech\b|technolog|\bai\b|artificial intelligence|\bllm\b|\bgpt\b|science|\bnasa\b|space|rocket|satellite|fusion|semiconductor|\bchip\b|frontier (lab|model)/.test(s)) return { c: "Tech & Science", ex: false };
  if (/health|\bfda\b|vaccine|pandemic|outbreak|disease|\bdrug\b|clinical|medic|\bcdc\b|\bwho\b/.test(s)) return { c: "Health", ex: false };
  if (/culture|entertain|\bmovie|\bfilm\b|box office|oscar|academy award|grammy|emmy|\balbum\b|\bmusic\b|\btv\b|series|celebrit|streaming chart/.test(s)) return { c: "Culture", ex: false };
  if (/world|geopolit|\bwar\b|ukraine|russia|israel|gaza|\biran\b|china|taiwan|north korea|\bnato\b|ceasefire|sanction|\bcoup\b|nuclear|missile|airstrike|hostage|treaty|summit|foreign|border/.test(s)) return { c: "World", ex: false };
  if (/politic|president|congress|senate|\bhouse\b|governor|cabinet|supreme court|shutdown|impeach|nominee|confirm|government|parliament|prime minister|chancellor|resign|appoint/.test(s)) return { c: "Politics", ex: false };
  return null;
}
// Classify a market from its raw category/tags plus the question text. Prefers a
// detectable category; if only excluded ones match (or nothing detectable does),
// the market is dropped. Returns a canonical name or null (skip this market).
function classifyMarket(rawList, question) {
  const seen = [];
  for (const r of (rawList || [])) { const m = canonCat(r); if (m) seen.push(m); }
  const det = seen.find((m) => !m.ex);
  if (det) return det.c;                       // a real, detectable category wins
  if (seen.some((m) => m.ex)) return null;     // only sports/crypto/etc. -> drop
  const q = canonCat(question);                // fall back to the question text
  return q && !q.ex ? q.c : null;              // unclassifiable or excluded -> drop
}

/* ----------------------------------------------------- preliminary scoring -
 * Every enumerated market gets a cheap run-up proxy from its 24h price change in
 * log-odds, standardised by a baseline daily logit-volatility floor. The real
 * Keown-Pinkerton CAR* replaces this for the markets we deep-fetch. */
const SIGMA0 = 0.55;   // typical 1-day logit swing on these markets (volatility floor)
function proxyRunUp(prob, change24h) {
  if (!(prob > 0 && prob < 1) || !isFinite(change24h)) return null;
  const before = clip(prob - change24h, 0.001, 0.999);
  const move = Math.abs(D.logit(prob) - D.logit(before));
  const sigma = move / SIGMA0;
  const score = clip(sigma / D.DEFAULTS.kRunUp, 0, 1);
  return {
    score, sigma_move: +sigma.toFixed(2), dir: change24h >= 0 ? "up" : "down", proxy: true,
    explain: "Implied probability moved " + (change24h >= 0 ? "+" : "") + Math.round(change24h * 100) +
      "c in 24h (~" + sigma.toFixed(1) + "σ vs a normal daily swing) — a preliminary run-up read, " +
      "refined from full price history when this market is inspected.",
  };
}
function scoreMarket(m) {
  const q = D.liquidityQ({ volumeUsd: m.volume24h, depthUsd: m.liquidity });
  const runUp = proxyRunUp(m.prob, m.change24h);
  const subs = { runUp: runUp };
  const fused = D.fuse(subs, { platform: m.platform, E: 0, Q: q.Q });
  m.Q = q.Q; m.E = 0; m.raw = fused.raw; m.index = fused.index; m.label = fused.label;
  m.detectors = { runUp, priceImpact: null, vpin: null, concentration: null, news: null };
  m.contributions = fused.contributions;
  return m;
}

/* ===================================================== ENUMERATE Polymarket */
function pmUrl(ev, m) {
  const slug = (ev && ev.slug) || (m && m.slug) || (m && Array.isArray(m.events) && m.events[0] && m.events[0].slug);
  return slug ? "https://polymarket.com/event/" + slug : "https://polymarket.com/markets";
}
function pmTagList(ev, m) {
  const tags = (ev && ev.tags) || (m && m.tags) || [];
  const out = [];
  if (Array.isArray(tags)) for (const t of tags) { const l = t && (t.label || t.slug || (typeof t === "string" ? t : null)); if (l) out.push(l); }
  if (m && m.category) out.push(m.category);
  if (ev && ev.category) out.push(ev.category);
  return out;
}
async function enumPoly(maxPages) {
  const rows = [];
  let offset = 0, pages = 0;
  do {
    const url = "https://gamma-api.polymarket.com/events?active=true&closed=false&archived=false" +
      "&limit=100&offset=" + offset + "&order=volume24hr&ascending=false";
    const evs = await getJSON(url, { timeout: 8000 }).catch(() => null);
    const arr = Array.isArray(evs) ? evs : (evs && (evs.data || evs.events)) || [];
    if (!arr.length) break;
    for (const ev of arr) {
      const evTags = pmTagList(ev, null);
      const url2 = pmUrl(ev, null);
      for (const m of (ev.markets || [])) {
        if (m.closed === true || m.active === false) continue;
        const question = String(m.question || m.groupItemTitle || ev.title || "").trim();
        if (!question) continue;
        // canonical, detectable category or skip (sports / crypto / etc.)
        const cat = classifyMarket(evTags.concat(pmTagList(null, m)), question);
        if (!cat) continue;
        const vol = num(m.volume24hr || m.volume_24hr || m.volume24Hr);
        const liq = num(m.liquidity || m.liquidityNum || m.liquidityClob);
        let prob = num(m.lastTradePrice);
        if (!prob && m.outcomePrices) { try { const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices; prob = num(op && op[0]); } catch (_) {} }
        if (!(prob > 0 && prob < 1)) continue;
        let tokenId = null;
        if (m.clobTokenIds) { try { const ct = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds; tokenId = ct && ct[0]; } catch (_) {} }
        rows.push(scoreMarket({
          id: "pm-" + (m.id || m.conditionId || (question.slice(0, 24))),
          platform: "polymarket", category: cat, question, url: url2,
          prob: +prob.toFixed(4), change24h: num(m.oneDayPriceChange),
          volume24h: Math.round(vol), liquidity: Math.round(liq),
          _cond: m.conditionId || null, _tokenId: tokenId,
        }));
      }
    }
    offset += 100; pages++;
  } while (pages < maxPages);
  return rows;
}

/* ========================================================= ENUMERATE Kalshi */
function kalshiHeaders(method, path) {
  const keyId = process.env.KALSHI_KEY_ID, pk = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !pk) return {};
  try {
    const ts = Date.now().toString();
    const sig = crypto.sign("sha256", Buffer.from(ts + method + path), {
      key: pk, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString("base64");
    return { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts };
  } catch (_) { return {}; }
}
function kUrl(ev) {
  const t = (ev && (ev.event_ticker || ev.series_ticker) || "").toLowerCase();
  return t ? "https://kalshi.com/markets/" + t : "https://kalshi.com/markets";
}
async function enumKalshi(maxPages) {
  const base = "https://api.elections.kalshi.com";
  const rows = [];
  let cursor = null, pages = 0;
  do {
    const url = base + "/trade-api/v2/events?limit=200&status=open&with_nested_markets=true" + (cursor ? "&cursor=" + cursor : "");
    const d = await getJSON(url, { headers: kalshiHeaders("GET", "/trade-api/v2/events"), timeout: 8000 }).catch(() => null);
    if (!d) break;
    for (const ev of (d.events || d.data || [])) {
      const series = ev.series_ticker || "";
      const url2 = kUrl(ev);
      const evTitle = String(ev.title || ev.sub_title || "");
      for (const m of (ev.markets || [])) {
        if (m.status && m.status !== "active" && m.status !== "open") continue;
        const question = String(m.title || m.yes_sub_title || evTitle || m.ticker || "").trim();
        if (!question) continue;
        // canonical, detectable category or skip (sports / crypto / etc.).
        // Kalshi gives a clean event.category; fall back to the question text.
        const cat = classifyMarket([ev.category, ev.sub_title].filter(Boolean), question + " " + evTitle);
        if (!cat) continue;
        const vol = num(m.volume_24h_fp || m.volume_24h);
        const oi = num(m.open_interest_fp || m.open_interest);
        // probability from the yes bid/ask midpoint or last price (cents -> 0..1)
        let cents = num(m.last_price);
        if (!cents) { const b = num(m.yes_bid), a = num(m.yes_ask); if (b || a) cents = (b + a) / 2; }
        const prob = cents > 1 ? cents / 100 : cents;
        if (!(prob > 0 && prob < 1)) continue;
        rows.push(scoreMarket({
          id: "k-" + (m.ticker || question.slice(0, 24)),
          platform: "kalshi", category: cat, question, url: url2,
          prob: +prob.toFixed(4),
          change24h: num(m.last_price_change) ? num(m.last_price_change) / 100 : 0,
          volume24h: Math.round(vol), liquidity: Math.round(oi),
          _series: series, _ticker: m.ticker,
        }));
      }
    }
    cursor = d.cursor; pages++;
  } while (cursor && pages < maxPages);
  return rows;
}

/* ======================================================= DEEP: price series */
async function pmPriceSeries(tokenId) {
  if (!tokenId) return null;
  const d = await getJSON(
    "https://clob.polymarket.com/prices-history?market=" + encodeURIComponent(tokenId) + "&interval=1w&fidelity=60",
    { timeout: 6000 }
  ).catch(() => null);
  const hist = d && (d.history || d.data || (Array.isArray(d) ? d : null));
  if (!Array.isArray(hist)) return null;
  return hist.map((x) => ({ t: num(x.t || x.timestamp), p: num(x.p || x.price) })).filter((x) => x.t && x.p > 0 && x.p < 1);
}
async function kalshiCandleSeries(series, ticker) {
  if (!series || !ticker) return null;
  const end = Math.floor(Date.now() / 1000), start = end - 7 * 86400;
  const path = "/trade-api/v2/series/" + series + "/markets/" + ticker + "/candlesticks";
  const d = await getJSON(
    "https://api.elections.kalshi.com" + path + "?start_ts=" + start + "&end_ts=" + end + "&period_interval=60",
    { headers: kalshiHeaders("GET", path), timeout: 6000 }
  ).catch(() => null);
  const cs = d && (d.candlesticks || d.data);
  if (!Array.isArray(cs)) return null;
  return cs.map((c) => {
    const pr = c.price || {};
    let raw = pr.mean_dollars != null ? pr.mean_dollars : (pr.close_dollars != null ? pr.close_dollars : (c.yes_bid && c.yes_bid.close_dollars));
    let p = num(raw); if (p > 1) p = p / 100;
    return { t: num(c.end_period_ts || c.ts), p, volume: num(c.volume) };
  }).filter((x) => x.t && x.p > 0 && x.p < 1);
}

/* ======================================== DEEP: Polymarket on-chain trades -- */
// Pull recent public trades for a market (Data API) -> per-wallet buy volumes
// (for HHI/concentration), a trade list (for VPIN), and volume bars (for Kyle's
// λ). Wallet addresses are public on-chain.
async function pmTrades(cond) {
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
  return trades;
}
function buildWalletVolumes(trades) {
  const byW = {};
  for (const t of trades) {
    const w = t.proxyWallet; if (!w) continue;
    if (String(t.side || "").toUpperCase() === "SELL") continue;
    const usd = num(t.size) * num(t.price); if (!usd) continue;
    const ts = num(t.timestamp || t.matchTime || t.time);
    const e = byW[w] || (byW[w] = { full: w, buyUsd: 0, firstTs: Infinity, lastTs: 0, nTrades: 0 });
    e.buyUsd += usd; e.nTrades++;
    if (ts) { if (ts < e.firstTs) e.firstTs = ts; if (ts > e.lastTs) e.lastTs = ts; }
  }
  return Object.keys(byW).map((w) => {
    const e = byW[w];
    return { wallet: w.slice(0, 6) + "…" + w.slice(-4), full: w, buyUsd: e.buyUsd,
      firstTs: isFinite(e.firstTs) ? e.firstTs : null, lastTs: e.lastTs || null, nTrades: e.nTrades };
  }).sort((a, b) => b.buyUsd - a.buyUsd);
}
// PHASE 3: synchronized-entry clustering. Wallets whose first buy in this market
// lands inside the same short window (and that each took a real position) look
// coordinated — shared funding / lockstep entry. We report the largest such
// cluster by combined share. This is a pattern flag, never proof of collusion.
function detectClusters(wallets, total) {
  const sized = wallets.filter((w) => w.firstTs && w.buyUsd / total >= 0.03);
  if (sized.length < 3) return [];
  const sorted = sized.slice().sort((a, b) => a.firstTs - b.firstTs);
  const WIN = 15 * 60;   // 15-minute synchronized-entry window
  let best = null;
  for (let i = 0; i < sorted.length; i++) {
    const grp = [sorted[i]];
    for (let j = i + 1; j < sorted.length && sorted[j].firstTs - sorted[i].firstTs <= WIN; j++) grp.push(sorted[j]);
    if (grp.length >= 3) {
      const share = grp.reduce((s, w) => s + w.buyUsd, 0) / total;
      if (!best || share > best.share) best = { size: grp.length, share: +share.toFixed(3), windowMin: 15,
        wallets: grp.map((w) => w.wallet), spanSec: grp[grp.length - 1].firstTs - grp[0].firstTs };
    }
  }
  return best ? [best] : [];
}
// PHASE 2: order book -> spread, depth, and order-flow imbalance (OFI).
async function fetchBook(m) {
  try {
    if (m.platform === "polymarket" && m._tokenId) {
      const d = await getJSON("https://clob.polymarket.com/book?token_id=" + encodeURIComponent(m._tokenId), { timeout: 5000 }).catch(() => null);
      if (!d) return null;
      const bids = (d.bids || []).map((b) => ({ p: num(b.price), s: num(b.size) }));
      const asks = (d.asks || []).map((a) => ({ p: num(a.price), s: num(a.size) }));
      if (!bids.length && !asks.length) return null;
      const bidUsd = bids.reduce((x, b) => x + b.p * b.s, 0), askUsd = asks.reduce((x, a) => x + a.p * a.s, 0);
      const bestBid = bids.reduce((mx, b) => Math.max(mx, b.p), 0), bestAsk = asks.reduce((mn, a) => Math.min(mn, a.p), 1);
      const flow = bidUsd + askUsd;
      return { spread: Math.max(0, +(bestAsk - bestBid).toFixed(3)), depthUsd: Math.round(bidUsd + askUsd),
        imbalance: flow > 0 ? +((bidUsd - askUsd) / flow).toFixed(3) : 0, bestBid: +bestBid.toFixed(3), bestAsk: +bestAsk.toFixed(3) };
    }
    if (m.platform === "kalshi" && m._ticker) {
      const path = "/trade-api/v2/markets/" + m._ticker + "/orderbook";
      const d = await getJSON("https://api.elections.kalshi.com" + path, { headers: kalshiHeaders("GET", path), timeout: 5000 }).catch(() => null);
      const ob = d && (d.orderbook || d);
      if (!ob) return null;
      const lv = (a) => (Array.isArray(a) ? a : []).map((x) => ({ p: num(x[0]) / 100, s: num(x[1]) }));
      const yes = lv(ob.yes), no = lv(ob.no);
      const yesUsd = yes.reduce((x, l) => x + l.p * l.s, 0), noUsd = no.reduce((x, l) => x + l.p * l.s, 0);
      const flow = yesUsd + noUsd;
      const bestYes = yes.reduce((mx, l) => Math.max(mx, l.p), 0), bestNo = no.reduce((mx, l) => Math.max(mx, l.p), 0);
      return { spread: Math.max(0, +(1 - bestYes - bestNo).toFixed(3)), depthUsd: Math.round(flow),
        imbalance: flow > 0 ? +((yesUsd - noUsd) / flow).toFixed(3) : 0, bestBid: +bestYes.toFixed(3), bestAsk: +(1 - bestNo).toFixed(3) };
    }
  } catch (_) {}
  return null;
}
function tradesToBarsAndList(trades) {
  // time-sorted trade list (price = probability, size, ts) + 5-min volume bars
  const tl = trades.map((t) => ({ ts: num(t.timestamp || t.matchTime || t.time), price: num(t.price), size: num(t.size) }))
    .filter((t) => t.ts && t.price > 0 && t.price < 1 && t.size > 0)
    .sort((a, b) => a.ts - b.ts);
  const bars = []; const W = 300; let cur = null;
  for (const t of tl) {
    const b = Math.floor(t.ts / W) * W;
    if (!cur || cur.t !== b) { if (cur) bars.push(cur); cur = { t: b, p: t.price, volume: 0 }; }
    cur.p = t.price; cur.volume += t.size * t.price;
  }
  if (cur) bars.push(cur);
  return { tradeList: tl, bars };
}

/* ---------------------------------------------------- DEEP: news-context (E) */
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
  if (!items.length) return null;
  const qwords = query.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  const rel = items.filter((it) => { const h = it.title.toLowerCase(); return qwords.some((w) => h.includes(w)); }).filter((it) => isFinite(it.ts));
  if (!rel.length) return null;
  rel.sort((a, b) => a.ts - b.ts);
  const mv = moveMs || Date.now();
  const near = rel.filter((it) => Math.abs(it.ts - mv) <= 24 * 3600 * 1000);
  // credibility from the source name (official wire/agency > general news > social)
  const cred = (src) => /reuters|associated press|\bap\b|bloomberg|official|\.gov|federal|white house|department/i.test(src || "") ? "official"
    : /twitter|x\.com|reddit|telegram|truth social/i.test(src || "") ? "social" : "news";
  if (near.length) {
    const top = near.slice().sort((a, b) => Math.abs(a.ts - mv) - Math.abs(b.ts - mv))[0];
    return { ctx: { credibility: cred(top.src), hoursFromMove: (top.ts - mv) / 3600000, preEvent: false, directionMatch: true },
      headline: top.title.slice(0, 160), source: top.src || "news" };
  }
  const after = rel.filter((it) => it.ts > mv);
  if (after.length) {
    const first = after[0]; const leadH = Math.round((first.ts - mv) / 3600000);
    if (leadH >= 1 && leadH <= 240) {
      return { ctx: { credibility: cred(first.src), hoursFromMove: leadH, preEvent: true, directionMatch: true },
        headline: first.title.slice(0, 160), source: first.src || "news", leadH };
    }
  }
  return null;
}

/* ===================================================== DEEP: enrich one row */
async function deepEnrich(m) {
  try {
    let series = null, tradeList = null, bars = null, wallets = null;
    if (m.platform === "polymarket") {
      const [ps, tr] = await Promise.all([pmPriceSeries(m._tokenId), m._cond ? pmTrades(m._cond) : Promise.resolve([])]);
      series = ps;
      if (tr && tr.length) { const x = tradesToBarsAndList(tr); tradeList = x.tradeList; bars = x.bars; wallets = buildWalletVolumes(tr); }
    } else {
      series = await kalshiCandleSeries(m._series, m._ticker);
      if (series) bars = series.filter((x) => isFinite(x.volume));
    }
    if (!series || series.length < 8) { m.deep = true; m.deepNote = "insufficient price history"; return m; }

    const runUp = D.runUp(series);
    const moveMs = series[series.length - 1].t * 1000;
    // Phase 2: order book (spread/depth/OFI), in parallel with the news check.
    const [news, book] = await Promise.all([
      newsCheck(newsQuery(m.question), moveMs).catch(() => null),
      fetchBook(m).catch(() => null),
    ]);
    const newsGap = D.newsGap(news ? news.ctx : null);

    // a real spread/depth from the book sharpens the liquidity gate Q
    if (book) m.Q = D.liquidityQ({ volumeUsd: m.volume24h, depthUsd: book.depthUsd, spread: book.spread, tradeCount: tradeList ? tradeList.length : null }).Q;

    let priceImpact = null, vpin = null, concentration = null;
    if (bars && bars.length >= 6) priceImpact = D.priceImpact(bars);
    if (tradeList && tradeList.length >= 12) vpin = D.vpin(tradeList);
    if (wallets && wallets.length >= 3) concentration = D.concentration(wallets, series[0].t);

    const subs = { runUp, vpin, priceImpact, concentration };
    const fused = D.fuse(subs, { platform: m.platform, E: newsGap.E, Q: m.Q, preEvent: newsGap.preEvent });

    m.index = fused.index; m.raw = fused.raw; m.E = newsGap.E; m.label = fused.label;
    m.contributions = fused.contributions;
    m.detectors = {
      runUp: runUp || m.detectors.runUp, priceImpact, vpin, concentration,
      news: Object.assign({}, newsGap, news ? { headline: news.headline, source: news.source, leadH: news.leadH || null } : {}),
    };
    if (book) m.book = { spread: book.spread, depthUsd: book.depthUsd, imbalance: book.imbalance, bestBid: book.bestBid, bestAsk: book.bestAsk };
    m.movedAt = moveMs;
    // a downsampled probability series for the inspector chart (cap ~120 points)
    const step = Math.max(1, Math.floor(series.length / 120));
    m.series = series.filter((_, i) => i % step === 0).map((x) => ({ t: x.t, p: +x.p.toFixed(4) }));
    if (m.platform === "polymarket" && wallets && wallets.length) {
      const total = wallets.reduce((s, w) => s + w.buyUsd, 0) || 1;
      // Phase 3: per-wallet "fresh" = first appeared in this market inside the
      // event/move window (showed up only for the move), and synchronized-entry
      // clusters. The move window starts at ~75% through the observed series.
      const moveStart = series[Math.floor(series.length * 0.75)].t;
      const clusters = detectClusters(wallets, total);
      m.onchain = {
        hhi: concentration ? concentration.hhi : null,
        top1: concentration ? concentration.top1 : null,
        fresh: concentration ? concentration.fresh : false,
        clusters,
        topWallets: wallets.slice(0, 5).map((w) => ({
          wallet: w.wallet, full: w.full, share: +(w.buyUsd / total).toFixed(3), usd: Math.round(w.buyUsd),
          fresh: !!(w.firstTs && w.firstTs >= moveStart && w.buyUsd / total >= 0.04), nTrades: w.nTrades,
        })),
        nWallets: wallets.length,
      };
    }
    m.deep = true;
    return m;
  } catch (_) { m.deep = true; m.deepNote = "enrichment error"; return m; }
}

/* ------------------------------------------------------------------ debug -- */
async function diagnose() {
  const o = {};
  try {
    const d = await getJSON("https://gamma-api.polymarket.com/events?active=true&closed=false&limit=3&order=volume24hr&ascending=false");
    const arr = Array.isArray(d) ? d : (d.data || []);
    o.pmEvents = { ok: true, count: arr.length, keys: arr[0] ? Object.keys(arr[0]) : [], slug: arr[0] && arr[0].slug,
      tags: arr[0] && arr[0].tags, marketKeys: arr[0] && arr[0].markets && arr[0].markets[0] ? Object.keys(arr[0].markets[0]) : [],
      sampleQuestion: arr[0] && arr[0].markets && arr[0].markets[0] && arr[0].markets[0].question };
  } catch (e) { o.pmEvents = { ok: false, error: e.message }; }
  try {
    const d = await getJSON("https://api.elections.kalshi.com/trade-api/v2/events?limit=20&status=open&with_nested_markets=true",
      { headers: kalshiHeaders("GET", "/trade-api/v2/events") });
    const arr = (d && (d.events || d.data)) || [];
    o.kalshiEvents = { ok: true, count: arr.length, categories: [...new Set(arr.map((e) => e.category).filter(Boolean))],
      marketKeys: arr[0] && arr[0].markets && arr[0].markets[0] ? Object.keys(arr[0].markets[0]) : [],
      sample: arr[0] && arr[0].markets && arr[0].markets[0] ? { ticker: arr[0].markets[0].ticker, title: arr[0].markets[0].title, last_price: arr[0].markets[0].last_price } : null };
  } catch (e) { o.kalshiEvents = { ok: false, error: e.message }; }
  return o;
}

/* ------------------------------------------------------------------- main -- */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const q = req.query || {};
  if (q.debug === "1" || q.debug === "true" || String(req.url || "").includes("debug=1")) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(await diagnose());
    return;
  }

  const limit = Math.min(200, Math.max(20, num(q.limit) || 120));
  const sources = { polymarket: "ok", kalshi: process.env.KALSHI_KEY_ID ? "ok(auth)" : "ok(public)" };

  const [pm, k] = await Promise.all([
    enumPoly(12).catch((e) => { sources.polymarket = "error: " + e.message; return []; }),
    enumKalshi(8).catch((e) => { sources.kalshi = "error: " + e.message; return []; }),
  ]);
  let all = [...pm, ...k];
  const scanned = all.length;

  // rank by preliminary index, then deep-enrich the top markets that aren't
  // thin-book artifacts (don't spend fetches on low-liquidity noise). Kalshi's
  // 24h-change field is unreliable, so also pull the top Kalshi markets by
  // volume into the deep set — otherwise the real run-up (from candlesticks)
  // would never be computed for them and they'd be starved from the ranking.
  const eligible = all.filter((m) => m.label !== "Low-liquidity artifact" && m.volume24h >= 2000);
  const deepSet = new Map();
  eligible.slice().sort((a, b) => b.index - a.index).slice(0, 12).forEach((m) => deepSet.set(m.id, m));
  eligible.filter((m) => m.platform === "kalshi").sort((a, b) => b.volume24h - a.volume24h).slice(0, 6).forEach((m) => deepSet.set(m.id, m));
  const deepTargets = [...deepSet.values()].slice(0, 18);
  await Promise.all(deepTargets.map((m) => deepEnrich(m)));

  // re-rank with the refined indices and trim the payload
  all.sort((a, b) => b.index - a.index);
  const markets = all.slice(0, limit).map((m) => {
    const { _cond, _tokenId, _series, _ticker, ...pub } = m;
    // expose the PUBLIC market-data websocket coordinates so the browser can
    // live-subscribe the open market (token_id / ticker are public, not secret).
    pub.ws = m.platform === "polymarket"
      ? { platform: "polymarket", token: _tokenId || null, cond: _cond || null }
      : { platform: "kalshi", ticker: _ticker || null };
    return pub;
  });

  const flagged = all.filter((m) => m.index >= 40).length;
  const high = all.filter((m) => m.index >= 70).length;
  const byPlat = { polymarket: pm.length, kalshi: k.length };
  const cats = {}; markets.forEach((m) => { cats[m.category] = (cats[m.category] || 0) + 1; });

  // back-compat compact "alerts" for the cron (the flagged subset)
  const alerts = markets.filter((m) => m.index >= 50).map((m) => ({
    id: m.id, ts: new Date().toISOString().slice(11, 16) + " UTC", platform: m.platform,
    market: m.question, detector: (m.contributions && m.contributions[0] && m.contributions[0].key) || "runUp",
    sev: m.index >= 70 ? "high" : "med", metric: m.index + " · " + m.label, index: m.index, url: m.url,
  }));

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    live: markets.length > 0,
    cadence: "near-real-time · enumeration every scan, deep-enrich top markets",
    coverage: { scanned, returned: markets.length, flagged, high, byPlatform: byPlat, categories: cats, deepEnriched: deepTargets.length },
    sources,
    markets,
    alerts,
  });
};
