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
// Per-engine detector weights (§3). INSIDER is retrospective (did money move
// before the outcome was public); MANIPULATION is in-market microstructure.
const INS_W = { runUp: 0.30, accumulation: 0.25, concentration: 0.25, longshot: 0.20 };
const MAN_W = { washTrade: 0.30, ramp: 0.25, vpin: 0.20, priceImpact: 0.25 };
const dArr = (W, picks) => Object.keys(W).map((k) => ({ key: k, weight: W[k], sub: picks[k] != null ? picks[k] : null }));
// APPLICABLE detector set is platform-aware (§2 platform asymmetry). Kalshi is
// anonymous — no wallet ledger — so the wallet-only checks (insider longshot,
// manipulation wash) are NOT applicable there and are excluded from coverage
// rather than counted as a permanent missing check. That lets Kalshi reach FULL
// coverage on the checks it can actually run (so it can be High-signal), and
// keeps the score honest instead of capping Kalshi at 3/4 forever.
function insiderDets(d, platform) {
  const picks = { runUp: d.runUp, accumulation: d.accumulation || d.volumeRunup, concentration: d.concentration };
  if (platform === "polymarket") picks.longshot = d.longshot;   // longshot win-screen needs wallet positions
  return dArr(INS_W, picks).filter((x) => platform === "polymarket" || x.key !== "longshot");
}
function manipDets(d, platform) {
  const picks = { ramp: d.ramp, vpin: d.vpin, priceImpact: d.priceImpact };
  if (platform === "polymarket") picks.washTrade = d.washTrade;  // self/linked-wallet matching needs wallets
  return dArr(MAN_W, picks).filter((x) => platform === "polymarket" || x.key !== "washTrade");
}
// fuse the active engine's detector set onto the market for the requested mode.
function scoreForMode(m, mode) {
  const d = m._det || {};
  if (mode === "manipulation") {
    const fused = D.fuse(manipDets(d, m.platform), { Q: m.Q });
    Object.assign(m, { index: fused.score, raw: fused.raw, label: fused.label, tier: fused.tier,
      coverageRan: fused.coverageRan, coverageTotal: fused.coverageTotal, fullCoverage: fused.fullCoverage,
      agreeing: fused.agreeing, contributions: fused.contributions, engine: "manipulation" });
    // washTrade only shown on Polymarket; on Kalshi it's a "not measurable" boundary (anonymous)
    m.detectors = { ramp: d.ramp || null, vpin: d.vpin || null, priceImpact: d.priceImpact || null,
      washTrade: m.platform === "polymarket" ? (d.washTrade || null) : { naReason: "Kalshi trades are anonymous — no wallet ledger to trace self-dealing." },
      spoofing: D.STREAMING_ONLY };
  } else {
    const news = d.news || { E: 0, preEvent: true };
    const fused = D.fuse(insiderDets(d, m.platform), { E: news.E || 0, Q: m.Q, preEvent: news.preEvent, categoryMult: D.categoryMult(m.category) });
    m.E = news.E || 0;
    Object.assign(m, { index: fused.score, raw: fused.raw, label: fused.label, tier: fused.tier,
      coverageRan: fused.coverageRan, coverageTotal: fused.coverageTotal, fullCoverage: fused.fullCoverage,
      agreeing: fused.agreeing, contributions: fused.contributions, engine: "insider" });
    m.detectors = { runUp: d.runUp || null, accumulation: d.accumulation || d.volumeRunup || null, concentration: d.concentration || null,
      longshot: m.platform === "polymarket" ? (d.longshot || null) : { naReason: "Kalshi trades are anonymous — no wallet positions to run the longshot win-screen." },
      news: d.news || null };
  }
  return m;
}
function scoreMarket(m, mode) {
  const q = D.liquidityQ({ volumeUsd: m.volume24h, depthUsd: m.liquidity });
  m.Q = q.Q;
  // cheap enumeration-tier read: only the run-up proxy is available pre-fetch.
  m._det = { runUp: proxyRunUp(m.prob, m.change24h) };
  return scoreForMode(m, mode || "insider");
}
// MANIPULATION helpers (computable after the fact from REST trade history).
function computeWash(trades, platform) {
  if (platform !== "polymarket") return null;        // Kalshi is anonymous -> no wash ledger
  const byW = {}; let total = 0;
  for (const t of trades) {
    const w = t.proxyWallet; if (!w) continue;
    const usd = num(t.size) * num(t.price); if (!usd) continue; total += usd;
    const e = byW[w] || (byW[w] = { buy: 0, sell: 0 });
    if (String(t.side || "").toUpperCase() === "SELL") e.sell += usd; else e.buy += usd;
  }
  if (total <= 0) return null;
  let selfMatched = 0; for (const w in byW) selfMatched += Math.min(byW[w].buy, byW[w].sell);
  return D.washTrade({ selfMatchedUsd: selfMatched * 2, totalUsd: total, linkedPairs: 0 });
}
function computeRamp(bars) {
  const n = bars.length; if (n < 6) return null;
  const total = bars.reduce((s, b) => s + b.volume, 0); if (total <= 0) return null;
  const ci = Math.floor(n * 0.8);
  const closeVol = bars.slice(ci).reduce((s, b) => s + b.volume, 0);
  const L = (p) => Math.log(clip(p, 0.02, 0.98) / (1 - clip(p, 0.02, 0.98)));
  const closeAvg = closeVol / Math.max(1, n - ci), baseAvg = (total - closeVol) / Math.max(1, ci);
  return D.ramp({ closeVolFrac: closeVol / total, moveIntoClose: Math.abs(L(bars[n - 1].p) - L(bars[ci].p)), volVsBaseline: baseAvg > 0 ? closeAvg / baseAvg : 1 });
}

/* ===================================================== ENUMERATE Polymarket */
// true only for a plain two-outcome Yes/No market
function isBinaryOutcomes(outcomes) {
  let arr = outcomes;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch (_) { return false; } }
  if (!Array.isArray(arr) || arr.length !== 2) return false;
  const set = arr.map((x) => String(x).trim().toLowerCase());
  return set.includes("yes") && set.includes("no");
}
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
async function enumPoly(maxPages, mode) {
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
      // cap a multi-candidate event to its most-active markets so a 40-candidate
      // field (e.g. "Who will the next Pope be?") can't flood the watchlist.
      const evMarkets = (ev.markets || []).slice()
        .sort((a, b) => num(b.volume24hr || b.volume24Hr) - num(a.volume24hr || a.volume24Hr)).slice(0, 4);
      for (const m of evMarkets) {
        if (m.closed === true || m.active === false) continue;
        const question = String(m.question || m.groupItemTitle || ev.title || "").trim();
        if (!question) continue;
        // canonical, detectable category or skip (sports / crypto / etc.)
        const cat = classifyMarket(evTags.concat(pmTagList(null, m)), question);
        if (!cat) continue;
        // BINARY ONLY: a plain Yes/No market (two outcomes). Drop scalar / ranged
        // / categorical markets — the surveillance math assumes a single YES price.
        if (!isBinaryOutcomes(m.outcomes)) continue;
        const vol = num(m.volume24hr || m.volume_24hr || m.volume24Hr);
        const liq = num(m.liquidity || m.liquidityNum || m.liquidityClob);
        let prob = num(m.lastTradePrice);
        if (!prob && m.outcomePrices) { try { const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices; prob = num(op && op[0]); } catch (_) {} }
        // skip extreme longshots: a 1c tick near 0/1 explodes in log-odds and an
        // insider edge on a <2% / >98% contract is implausible noise.
        if (!(prob >= 0.02 && prob <= 0.98)) continue;
        let tokenId = null;
        if (m.clobTokenIds) { try { const ct = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds; tokenId = ct && ct[0]; } catch (_) {} }
        rows.push(scoreMarket({
          id: "pm-" + (m.id || m.conditionId || (question.slice(0, 24))),
          platform: "polymarket", category: cat, question, url: url2,
          prob: +prob.toFixed(4), change24h: num(m.oneDayPriceChange),
          volume24h: Math.round(vol), liquidity: Math.round(liq),
          _cond: m.conditionId || null, _tokenId: tokenId,
        }, mode));
      }
    }
    offset += 100; pages++;
  } while (pages < maxPages);
  return rows;
}

/* ============================================ ENUMERATE Polymarket — RESOLVED
 * The INSIDER engine is RETROSPECTIVE: it scans markets that have already
 * RESOLVED so the outcome (`won`) is known and the longshot / accumulation
 * screens can be evaluated against the truth. Gamma exposes resolved events via
 * closed=true; the winning side comes from the final settled outcomePrices.
 * Each row is aligned to its resolution timestamp; deepEnrich() scores the
 * pre-event window. Guarded end-to-end so a field/shape change degrades to the
 * open-market path rather than breaking the feed. */
function pmResolvedWinner(m) {
  // final settled prices: [YES, NO] in {0,1}. Returns true=YES won, false=NO, null=unknown.
  let op = m.outcomePrices;
  if (typeof op === "string") { try { op = JSON.parse(op); } catch (_) { op = null; } }
  if (Array.isArray(op) && op.length === 2) {
    const yes = num(op[0]), no = num(op[1]);
    if (yes >= 0.95 && no <= 0.05) return true;
    if (no >= 0.95 && yes <= 0.05) return false;
  }
  return null;
}
async function enumPolyResolved(maxPages, mode, lookbackDays) {
  const rows = [];
  let offset = 0, pages = 0;
  const cutoff = Date.now() - (lookbackDays || D.DEFAULTS.lookbackDays) * 86400000;
  do {
    const url = "https://gamma-api.polymarket.com/events?closed=true&archived=false" +
      "&limit=100&offset=" + offset + "&order=endDate&ascending=false";
    const evs = await getJSON(url, { timeout: 8000 }).catch(() => null);
    const arr = Array.isArray(evs) ? evs : (evs && (evs.data || evs.events)) || [];
    if (!arr.length) break;
    let anyRecent = false;
    for (const ev of arr) {
      const evTags = pmTagList(ev, null);
      const url2 = pmUrl(ev, null);
      const evMarkets = (ev.markets || []).slice()
        .sort((a, b) => num(b.volume || b.volumeNum) - num(a.volume || a.volumeNum)).slice(0, 4);
      for (const m of evMarkets) {
        const question = String(m.question || m.groupItemTitle || ev.title || "").trim();
        if (!question) continue;
        const cat = classifyMarket(evTags.concat(pmTagList(null, m)), question);
        if (!cat) continue;
        if (!isBinaryOutcomes(m.outcomes)) continue;
        const won = pmResolvedWinner(m);
        if (won == null) continue;                          // need a clean settled outcome
        const resolvedMs = Date.parse(m.closedTime || ev.closedTime || m.endDate || ev.endDate || 0) || 0;
        if (resolvedMs && resolvedMs < cutoff) continue;    // only RECENTLY resolved
        if (resolvedMs) anyRecent = true;
        const vol = num(m.volume || m.volumeNum || m.volume24hr);
        const liq = num(m.liquidity || m.liquidityNum);
        let tokenId = null;
        if (m.clobTokenIds) { try { const ct = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds; tokenId = ct && ct[0]; } catch (_) {} }
        const row = scoreMarket({
          id: "pm-" + (m.id || m.conditionId || question.slice(0, 24)),
          platform: "polymarket", category: cat, question, url: url2,
          prob: 0.5,                                        // real pre-event implied is computed in deepEnrich
          change24h: 0, volume24h: Math.round(vol), liquidity: Math.round(liq),
          _cond: m.conditionId || null, _tokenId: tokenId, _won: won, _resolvedAt: resolvedMs || null, _resolved: true,
        }, mode);
        rows.push(row);
      }
    }
    offset += 100; pages++;
    if (!anyRecent && pages >= 2) break;                    // walked past the lookback window
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
// Kalshi web pages live at /markets/{series_ticker}/{event_ticker} (both lower-
// cased). The event_ticker alone (e.g. KXELONMARS-99) does not resolve.
function kUrl(ev) {
  const series = (ev && ev.series_ticker || "").toLowerCase();
  const event = (ev && ev.event_ticker || "").toLowerCase();
  if (series && event) return "https://kalshi.com/markets/" + series + "/" + event;
  if (series) return "https://kalshi.com/markets/" + series;
  return "https://kalshi.com/markets";
}
async function enumKalshi(maxPages, mode) {
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
      // cap multi-candidate events to their most-active markets (see enumPoly)
      const evMarkets = (ev.markets || []).slice()
        .sort((a, b) => num(b.volume_24h_fp || b.volume_24h) - num(a.volume_24h_fp || a.volume_24h)).slice(0, 4);
      for (const m of evMarkets) {
        if (m.status && m.status !== "active" && m.status !== "open") continue;
        const question = String(m.title || m.yes_sub_title || evTitle || m.ticker || "").trim();
        if (!question) continue;
        // canonical, detectable category or skip (sports / crypto / etc.).
        // Kalshi gives a clean event.category; fall back to the question text.
        const cat = classifyMarket([ev.category, ev.sub_title].filter(Boolean), question + " " + evTitle);
        if (!cat) continue;
        // BINARY ONLY: Kalshi tags scalar/range markets with market_type; keep
        // plain binary Yes/No contracts.
        if (m.market_type && m.market_type !== "binary") continue;
        const vol = num(m.volume_24h_fp || m.volume_24h || m.volume_fp);
        const oi = num(m.open_interest_fp || m.open_interest);
        const liqD = num(m.liquidity_dollars);
        // Kalshi quotes prices in DOLLARS (0..1): last_price_dollars, yes_bid/ask_dollars.
        let prob = num(m.last_price_dollars != null ? m.last_price_dollars : m.last_price);
        if (!(prob > 0)) { const b = num(m.yes_bid_dollars), a = num(m.yes_ask_dollars); if (b || a) prob = (b + a) / 2; }
        if (prob > 1) prob = prob / 100;                 // guard if a cents field slips in
        // skip extreme longshots (noise near 0/1)
        if (!(prob >= 0.02 && prob <= 0.98)) continue;
        const prev = num(m.previous_price_dollars);
        const change24h = (prev > 0 && prev < 1) ? (prob - prev) : 0;
        rows.push(scoreMarket({
          id: "k-" + (m.ticker || question.slice(0, 24)),
          platform: "kalshi", category: cat, question, url: url2,
          prob: +prob.toFixed(4),
          change24h: +change24h.toFixed(4),
          volume24h: Math.round(vol), liquidity: Math.round(liqD || oi),
          _series: series, _ticker: m.ticker,
        }, mode));
      }
    }
    cursor = d.cursor; pages++;
  } while (cursor && pages < maxPages);
  return rows;
}
/* Kalshi RESOLVED markets for the retrospective insider engine. The markets
 * endpoint exposes status=settled with a `result` (yes/no) — the known outcome.
 * Kalshi is anonymous (no wallets), so the insider screens that survive here are
 * the volume run-up and the candlestick run-up, scored over the pre-settlement
 * window. Guarded; degrades to the open path on any shape change. */
async function enumKalshiResolved(maxPages, mode, lookbackDays) {
  const base = "https://api.elections.kalshi.com";
  const rows = [];
  let cursor = null, pages = 0;
  const cutoff = Date.now() - (lookbackDays || D.DEFAULTS.lookbackDays) * 86400000;
  do {
    const path = "/trade-api/v2/markets";
    const url = base + path + "?limit=200&status=settled" + (cursor ? "&cursor=" + cursor : "");
    const d = await getJSON(url, { headers: kalshiHeaders("GET", path), timeout: 8000 }).catch(() => null);
    if (!d) break;
    const mkts = d.markets || d.data || [];
    if (!mkts.length) break;
    let anyRecent = false;
    for (const m of mkts) {
      const result = String(m.result || "").toLowerCase();
      if (result !== "yes" && result !== "no") continue;     // need a clean settlement
      const resolvedMs = Date.parse(m.settlement_time || m.close_time || m.expiration_time || 0) || 0;
      if (resolvedMs && resolvedMs < cutoff) continue;
      if (resolvedMs) anyRecent = true;
      const question = String(m.title || m.yes_sub_title || m.ticker || "").trim();
      if (!question) continue;
      const cat = classifyMarket([m.category].filter(Boolean), question);
      if (!cat) continue;
      if (m.market_type && m.market_type !== "binary") continue;
      const series = m.event_ticker ? (m.event_ticker.split("-")[0] || m.ticker.split("-")[0]) : (m.ticker || "").split("-")[0];
      const vol = num(m.volume_fp || m.volume);
      rows.push(scoreMarket({
        id: "k-" + (m.ticker || question.slice(0, 24)),
        platform: "kalshi", category: cat, question, url: kUrl({ series_ticker: series, event_ticker: m.event_ticker }),
        prob: 0.5, change24h: 0, volume24h: Math.round(vol), liquidity: 0,
        _series: series, _ticker: m.ticker, _won: result === "yes", _resolvedAt: resolvedMs || null, _resolved: true,
      }, mode));
    }
    cursor = d.cursor; pages++;
    if (!anyRecent && pages >= 2) break;
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
// Kalshi trades are PUBLIC (anonymous): price + count + taker side + time. We use
// them for the same order-flow checks as Polymarket — VPIN (one-sided buying) and
// Kyle's λ (price impact) — even though there is no wallet ledger.
async function kalshiTrades(ticker) {
  if (!ticker) return [];
  const path = "/trade-api/v2/markets/trades";
  const d = await getJSON(
    "https://api.elections.kalshi.com" + path + "?ticker=" + encodeURIComponent(ticker) + "&limit=1000",
    { headers: kalshiHeaders("GET", path), timeout: 6000 }
  ).catch(() => null);
  const arr = (d && (d.trades || d.data)) || [];
  return Array.isArray(arr) ? arr : [];
}
function kalshiTradeRows(trades) {
  // -> time-sorted {ts, price(0..1), size} list + 5-min volume bars
  const tl = trades.map((t) => {
    let cents = num(t.yes_price != null ? t.yes_price : t.price);
    let p = cents > 1 ? cents / 100 : cents;
    const ts = t.created_time ? Math.floor(Date.parse(t.created_time) / 1000) : num(t.ts || t.created_ts);
    return { ts, price: p, size: num(t.count || t.size) };
  }).filter((t) => t.ts && t.price > 0 && t.price < 1 && t.size > 0).sort((a, b) => a.ts - b.ts);
  const bars = []; const W = 300; let cur = null;
  for (const t of tl) {
    const b = Math.floor(t.ts / W) * W;
    if (!cur || cur.t !== b) { if (cur) bars.push(cur); cur = { t: b, p: t.price, volume: 0 }; }
    cur.p = t.price; cur.volume += t.size * t.price;
  }
  if (cur) bars.push(cur);
  return { tradeList: tl, bars };
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

/* ===================================== DEEP: Polymarket on-chain holders ----
 * Polymarket settles on-chain, so the real TOP HOLDERS (current positions) are
 * public via the Data API /holders endpoint, each with its actual wallet
 * address (clickable on Polygonscan). This is the accurate "who holds this
 * market" list — not just who traded recently. */
async function pmHolders(cond) {
  if (!cond) return [];
  const d = await getJSON("https://data-api.polymarket.com/holders?market=" + encodeURIComponent(cond) + "&limit=100", { timeout: 6000 }).catch(() => null);
  const rowsOf = (arr) => (arr || []).map((x) => ({
    full: x.proxyWallet || x.user || x.wallet || x.address,
    amount: num(x.amount != null ? x.amount : (x.shares != null ? x.shares : (x.balance != null ? x.balance : (x.size != null ? x.size : x.value)))),
    name: x.name || x.pseudonym || null,
  })).filter((r) => r.full && r.amount > 0);
  let list = [];
  if (Array.isArray(d)) {
    if (d.length && Array.isArray(d[0].holders)) d.forEach((g) => list.push(...rowsOf(g.holders)));   // grouped by token (YES/NO)
    else list = rowsOf(d);
  } else if (d && Array.isArray(d.holders)) list = rowsOf(d.holders);
  const by = {}; const nameOf = {};
  list.forEach((r) => { by[r.full] = (by[r.full] || 0) + r.amount; if (r.name) nameOf[r.full] = r.name; });
  return Object.keys(by).map((w) => ({ full: w, amount: by[w], name: nameOf[w] || null })).sort((a, b) => b.amount - a.amount);
}
// a wallet's first-ever Polymarket activity timestamp (seconds) -> "fresh" if it
// was created/active only shortly before the move. Real check, one call/wallet.
async function pmFirstSeen(wallet) {
  if (!wallet) return null;
  const d = await getJSON("https://data-api.polymarket.com/activity?user=" + encodeURIComponent(wallet) + "&limit=1&sortDirection=ASC", { timeout: 5000 }).catch(() => null);
  const arr = Array.isArray(d) ? d : (d && (d.data || d.activity)) || [];
  const t = arr[0] && num(arr[0].timestamp || arr[0].time || arr[0].ts);
  return t || null;
}
/* ----------------------------------------- DEEP: Polymarket recent trades ---
 * Recent trades drive the order-flow checks (VPIN, Kyle's λ) and the
 * synchronized-entry clustering. */
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
      // levels may be yes/no or yes_dollars/no_dollars; price in dollars or cents
      const lv = (a) => (Array.isArray(a) ? a : []).map((x) => { let p = num(x[0]); if (p > 1) p = p / 100; return { p, s: num(x[1]) }; });
      const yes = lv(ob.yes_dollars || ob.yes), no = lv(ob.no_dollars || ob.no);
      if (!yes.length && !no.length) return null;            // thin/empty book -> don't pollute Q
      const yesUsd = yes.reduce((x, l) => x + l.p * l.s, 0), noUsd = no.reduce((x, l) => x + l.p * l.s, 0);
      const flow = yesUsd + noUsd;
      if (!(flow > 0)) return null;
      const bestYes = yes.reduce((mx, l) => Math.max(mx, l.p), 0), bestNo = no.reduce((mx, l) => Math.max(mx, l.p), 0);
      return { spread: Math.max(0, +(1 - bestYes - bestNo).toFixed(3)), depthUsd: Math.round(flow),
        imbalance: +((yesUsd - noUsd) / flow).toFixed(3), bestBid: +bestYes.toFixed(3), bestAsk: +(1 - bestNo).toFixed(3) };
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
async function deepEnrich(m, mode) {
  try {
    let series = null, tradeList = null, bars = null, wallets = null, holders = null, rawTrades = null;
    if (m.platform === "polymarket") {
      const [ps, tr, hd] = await Promise.all([
        pmPriceSeries(m._tokenId),
        m._cond ? pmTrades(m._cond) : Promise.resolve([]),
        m._cond ? pmHolders(m._cond) : Promise.resolve([]),
      ]);
      series = ps; holders = hd; rawTrades = tr;
      if (tr && tr.length) { const x = tradesToBarsAndList(tr); tradeList = x.tradeList; bars = x.bars; wallets = buildWalletVolumes(tr); }
    } else {
      // Kalshi: candlesticks for the price series + PUBLIC trades for order-flow.
      const [cs, tr] = await Promise.all([kalshiCandleSeries(m._series, m._ticker), kalshiTrades(m._ticker)]);
      series = cs; rawTrades = tr;
      if (tr && tr.length) { const x = kalshiTradeRows(tr); tradeList = x.tradeList; bars = x.bars; }
      if ((!bars || bars.length < 6) && series) bars = series.filter((x) => isFinite(x.volume) && x.volume > 0);
    }
    if (!series || series.length < 8) { m.deep = true; m.deepNote = "insufficient price history"; return m; }

    const runUp = D.runUp(series);
    const moveMs = series[series.length - 1].t * 1000;
    // For a RESOLVED market the live price has settled to ~0/1, so the real
    // "implied odds the bet was placed at" is the calm PRE-event level — the
    // median of the estimation window before any run-up. This is what the
    // longshot screen compares against the known outcome.
    let impliedPre = null;
    if (m._resolved) {
      const ps = series.map((x) => x.p);
      impliedPre = D.median(ps.slice(0, Math.max(3, Math.floor(ps.length * D.DEFAULTS.estFrac))));
      if (impliedPre > 0 && impliedPre < 1) m.prob = +impliedPre.toFixed(4);
    }
    // Phase 2: order book (spread/depth/OFI), in parallel with the news check.
    const [news, book] = await Promise.all([
      newsCheck(newsQuery(m.question), moveMs).catch(() => null),
      fetchBook(m).catch(() => null),
    ]);
    const newsGap = D.newsGap(news ? news.ctx : null);

    // a real spread/depth from the book sharpens the liquidity gate Q
    if (book) m.Q = D.liquidityQ({ volumeUsd: m.volume24h, depthUsd: book.depthUsd, spread: book.spread, tradeCount: tradeList ? tradeList.length : null }).Q;

    let priceImpact = null, vpin = null, concentration = null, freshTop = {};
    if (bars && bars.length >= 6) priceImpact = D.priceImpact(bars);
    if (tradeList && tradeList.length >= 12) vpin = D.vpin(tradeList);
    if (m.platform === "polymarket") {
      // concentration from REAL current top holders (positions), not buy-flow.
      if (holders && holders.length >= 3) {
        const total = holders.reduce((s, h) => s + h.amount, 0) || 1;
        const shares = holders.map((h) => h.amount / total);
        const hhi = shares.reduce((s, x) => s + x * x, 0);
        const top1 = shares[0];
        // REAL fresh check: look up the top 3 holders' first-ever activity and
        // flag any whose wallet only became active shortly before the move.
        const probe = holders.slice(0, 3);
        const seen = await Promise.all(probe.map((h) => pmFirstSeen(h.full).catch(() => null)));
        probe.forEach((h, i) => { const fs = seen[i]; freshTop[h.full] = !!(fs && (moveMs / 1000 - fs) <= 14 * 86400 && fs <= moveMs / 1000 + 86400); });
        const anyFresh = Object.values(freshTop).some(Boolean);
        concentration = { score: clip(0.55 * hhi + 0.45 * top1 + (anyFresh ? 0.12 : 0), 0, 1),
          hhi: +hhi.toFixed(3), top1: +top1.toFixed(3), nWallets: holders.length, fresh: anyFresh };
      }
    } else if (book && book.depthUsd > 0) {
      // Kalshi has no wallet ledger, but its order book shows how lopsided the
      // resting orders are — concentrated one-sided pressure goes in this slot.
      const imb = Math.abs(book.imbalance || 0);
      concentration = { score: clip(imb, 0, 1), kind: "orderbook", imbalance: +imb.toFixed(2),
        side: (book.imbalance || 0) >= 0 ? "buy" : "sell", depthUsd: book.depthUsd,
        bestBid: book.bestBid, bestAsk: book.bestAsk };
    }

    // ---- INSIDER extras: pre-event accumulation + a longshot-position screen
    let accumulation = null, longshot = null, volumeRunup = null;
    if (m.platform === "polymarket" && wallets && wallets.length) {
      accumulation = D.accumulation({ netPreUsd: wallets[0].buyUsd, soldFracPre: null, won: m._won != null ? m._won : null });
    } else if (m.platform === "kalshi" && bars && bars.length >= 6) {
      const half = Math.floor(bars.length / 2);
      const preVol = bars.slice(half).reduce((s, b) => s + b.volume, 0), baseVol = bars.slice(0, half).reduce((s, b) => s + b.volume, 0) || 1;
      volumeRunup = D.volumeRunup({ preVol, baseVol });
    }
    if (m.platform === "polymarket" && holders && holders.length) {
      const implied = (m._resolved && impliedPre != null) ? impliedPre : m.prob;
      longshot = D.longshot({ stakeUsd: holders[0].amount, impliedProb: implied, won: m._won != null ? m._won : null, category: m.category });
    }
    // ---- MANIPULATION: wash/self-trading (from trades) + ramp/marking-the-close
    let washTrade = null, ramp = null;
    if (rawTrades && rawTrades.length >= 10) washTrade = computeWash(rawTrades, m.platform);
    if (bars && bars.length >= 6) ramp = computeRamp(bars);

    // stash every raw detector; score for the requested mode
    m._det = { runUp, vpin, priceImpact, concentration, news: Object.assign({}, newsGap, news ? { headline: news.headline, source: news.source, leadH: news.leadH || null } : {}),
      accumulation, volumeRunup, longshot, washTrade, ramp };
    scoreForMode(m, mode);
    if (book) m.book = { spread: book.spread, depthUsd: book.depthUsd, imbalance: book.imbalance, bestBid: book.bestBid, bestAsk: book.bestAsk };
    m.movedAt = moveMs;
    // a downsampled probability series for the inspector chart (cap ~120 points)
    const step = Math.max(1, Math.floor(series.length / 120));
    m.series = series.filter((_, i) => i % step === 0).map((x) => ({ t: x.t, p: +x.p.toFixed(4) }));
    if (m.platform === "polymarket" && holders && holders.length) {
      const total = holders.reduce((s, h) => s + h.amount, 0) || 1;
      // synchronized-entry clusters still come from recent trade timing
      const clusters = (wallets && wallets.length) ? detectClusters(wallets, wallets.reduce((s, w) => s + w.buyUsd, 0) || 1) : [];
      const short = (w) => w.slice(0, 6) + "…" + w.slice(-4);
      m.onchain = {
        hhi: concentration ? concentration.hhi : null,
        top1: concentration ? concentration.top1 : null,
        fresh: concentration ? concentration.fresh : false,
        clusters,
        topWallets: holders.slice(0, 5).map((h) => ({
          wallet: h.name || short(h.full), full: h.full, share: +(h.amount / total).toFixed(3),
          usd: Math.round(h.amount), fresh: !!freshTop[h.full],
        })),
        nWallets: holders.length,
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
  // end-to-end: what the enumerators actually parse (confirms field-mapping +
  // category filtering, and that Kalshi markets now survive)
  try {
    const [pm, k] = await Promise.all([enumPoly(2).catch(() => []), enumKalshi(2).catch(() => [])]);
    const cats = {}; [...pm, ...k].forEach((m) => { cats[m.category] = (cats[m.category] || 0) + 1; });
    const samp = (m) => ({ platform: m.platform, category: m.category, prob: m.prob, index: m.index, label: m.label, q: m.question.slice(0, 60) });
    o.enumerated = {
      polymarket: pm.length, kalshi: k.length, categories: cats,
      kalshiSample: k.slice(0, 5).map(samp), polymarketSample: pm.slice(0, 5).map(samp),
    };
  } catch (e) { o.enumerated = { error: e.message }; }
  // deep-tier shapes for one Kalshi market (candlesticks) + one PM book
  try {
    const k = await enumKalshi(1).catch(() => []);
    const km = k[0];
    if (km) {
      const obPath = "/trade-api/v2/markets/" + km._ticker + "/orderbook";
      const rawOb = await getJSON("https://api.elections.kalshi.com" + obPath, { headers: kalshiHeaders("GET", obPath), timeout: 5000 }).catch((e) => ({ error: String(e && e.message) }));
      o.kalshiDeep = { ticker: km._ticker, series: km._series,
        candles: await kalshiCandleSeries(km._series, km._ticker).then((s) => s ? { points: s.length, last: s[s.length - 1] } : null).catch((e) => ({ error: String(e && e.message) })),
        rawOrderbookKeys: rawOb && !rawOb.error ? Object.keys(rawOb.orderbook || rawOb) : null,
        rawOrderbookSample: JSON.stringify(rawOb).slice(0, 360),
        trades: await kalshiTrades(km._ticker).then((t) => ({ count: t.length, sample: t[0] || null })).catch((e) => ({ error: String(e && e.message) })),
        book: await fetchBook(km).catch((e) => ({ error: String(e && e.message) })) };
    }
  } catch (e) { o.kalshiDeep = { error: e.message }; }
  // Polymarket holders endpoint shape (for accurate top-holder wallet addresses)
  try {
    const pm = await enumPoly(1).catch(() => []);
    const cond = (pm.find((x) => x._cond) || {})._cond;
    if (cond) {
      const raw = await getJSON("https://data-api.polymarket.com/holders?market=" + encodeURIComponent(cond) + "&limit=5", { timeout: 6000 }).catch((e) => ({ error: String(e && e.message) }));
      o.pmHolders = { cond, isArray: Array.isArray(raw), keys: Array.isArray(raw) ? (raw[0] ? Object.keys(raw[0]) : []) : Object.keys(raw || {}), sample: JSON.stringify(raw).slice(0, 420) };
    }
  } catch (e) { o.pmHolders = { error: e.message }; }
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
  const mode = (q.mode === "manipulation") ? "manipulation" : "insider";   // §5 read-API mode
  const fPlatform = (q.platform === "kalshi" || q.platform === "polymarket") ? q.platform : null;
  const fCategory = q.category ? String(q.category) : null;
  const sources = { polymarket: "ok", kalshi: process.env.KALSHI_KEY_ID ? "ok(auth)" : "ok(public)" };

  let pm, k;
  if (mode === "insider") {
    // RETROSPECTIVE: scan recently RESOLVED markets so outcomes are known.
    [pm, k] = await Promise.all([
      enumPolyResolved(8, mode, D.DEFAULTS.lookbackDays).catch((e) => { sources.polymarket = "resolved error: " + e.message; return []; }),
      enumKalshiResolved(6, mode, D.DEFAULTS.lookbackDays).catch((e) => { sources.kalshi = "resolved error: " + e.message; return []; }),
    ]);
    sources.polymarket = "resolved(" + pm.length + ")"; sources.kalshi = "resolved(" + k.length + ")";
    // Augment with OPEN near-resolution markets when the resolved set is thin,
    // so the engine always has a universe to show (outcome still pending there).
    if (pm.length < 12) { const o = await enumPoly(6, mode).catch(() => []); pm = pm.concat(o); sources.polymarket += "+open(" + o.length + ")"; }
    if (k.length < 8) { const o = await enumKalshi(5, mode).catch(() => []); k = k.concat(o); sources.kalshi += "+open(" + o.length + ")"; }
  } else {
    // LIVE microstructure watch operates on OPEN markets.
    [pm, k] = await Promise.all([
      enumPoly(12, mode).catch((e) => { sources.polymarket = "error: " + e.message; return []; }),
      enumKalshi(8, mode).catch((e) => { sources.kalshi = "error: " + e.message; return []; }),
    ]);
  }
  // dedup by id (resolved + open augmentation are disjoint, but be defensive)
  const _seen = new Set();
  let all = [...pm, ...k].filter((m) => (m && m.id && !_seen.has(m.id)) ? (_seen.add(m.id), true) : false);
  if (fPlatform) all = all.filter((m) => m.platform === fPlatform);
  if (fCategory) all = all.filter((m) => m.category === fCategory);
  const scanned = all.length;

  // pick the deep-enrich batch. Insider ranks by the preliminary run-up read;
  // manipulation has no enumeration-tier signal, so it goes by activity (volume).
  const eligible = all.filter((m) => m.label !== "Low-liquidity artifact" && m.volume24h >= 2000);
  const deepSet = new Map();
  // Always reserve slots for BOTH platforms so neither engine becomes single-
  // platform (manipulation isn't Polymarket-only; insider isn't Kalshi-only).
  const takeByVol = (rows, n) => rows.slice().sort((a, b) => b.volume24h - a.volume24h).slice(0, n).forEach((m) => deepSet.set(m.id, m));
  const takeByIdx = (rows, n) => rows.slice().sort((a, b) => b.index - a.index).slice(0, n).forEach((m) => deepSet.set(m.id, m));
  const pmE = eligible.filter((m) => m.platform === "polymarket");
  const kE = eligible.filter((m) => m.platform === "kalshi");
  if (mode === "manipulation") {
    // microstructure has no enumeration-tier signal -> rank by activity (volume),
    // but guarantee a Kalshi cohort (ramp/VPIN/λ work there) and a PM cohort.
    takeByVol(pmE, 11); takeByVol(kE, 9);
  } else {
    // Retrospective insider: prioritise RESOLVED markets (real `won` outcome ->
    // longshot/accumulation can run), then the strongest preliminary run-ups,
    // with guaranteed cohorts on BOTH platforms.
    takeByVol(eligible.filter((m) => m._resolved), 8);
    takeByIdx(pmE, 7); takeByIdx(kE, 7);
  }
  const deepTargets = [...deepSet.values()].slice(0, 22);
  await Promise.all(deepTargets.map((m) => deepEnrich(m, mode)));

  // re-rank with the refined indices and trim the payload
  all.sort((a, b) => b.index - a.index);
  const markets = all.slice(0, limit).map((m) => {
    const { _cond, _tokenId, _series, _ticker, _det, _won, _resolved, _resolvedAt, ...pub } = m;
    pub.resolved = !!_resolved; if (_resolvedAt) pub.resolvedAt = new Date(_resolvedAt).toISOString();
    pub.ws = m.platform === "polymarket"
      ? { platform: "polymarket", token: _tokenId || null, cond: _cond || null }
      : { platform: "kalshi", ticker: _ticker || null };
    return pub;
  });

  // honest tier counts (High-signal requires full coverage + >=2 agreeing checks)
  const highSignal = all.filter((m) => m.tier === "High-signal").length;
  const elevated = all.filter((m) => m.tier === "Elevated").length;
  const watch = all.filter((m) => m.tier === "Watch").length;
  const byPlat = { polymarket: pm.length, kalshi: k.length };
  const cats = {}; markets.forEach((m) => { cats[m.category] = (cats[m.category] || 0) + 1; });

  // back-compat compact "alerts" for the cron (the flagged subset)
  const alerts = markets.filter((m) => m.tier === "High-signal" || m.tier === "Elevated").map((m) => ({
    id: m.id, ts: new Date().toISOString().slice(11, 16) + " UTC", platform: m.platform,
    market: m.question, detector: (m.contributions && m.contributions[0] && m.contributions[0].key) || "runUp",
    sev: m.tier === "High-signal" ? "high" : "med", metric: m.index + " · " + m.tier, index: m.index, url: m.url,
  }));

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    live: markets.length > 0,
    mode, engine: mode,
    cadence: "rotating scan · enumerate all, deep-enrich the stalest/most-screened batch each run",
    // streaming-only detectors are out of scope on this serverless+cron stack (§0A.1)
    streamingBoundary: (mode === "manipulation") ? D.STREAMING_ONLY : null,
    coverage: {
      // "watching" = the full enumerated universe reached this run; "evaluated" =
      // the bounded batch that got the deep (multi-check) scoring this run.
      watching: scanned, evaluated: deepTargets.length, returned: markets.length,
      highSignal, elevated, watch, byPlatform: byPlat, categories: cats,
    },
    sources,
    markets,
    alerts,
  });
};
