/* ============================================================================
 *  forensics/poly.js — focused Polymarket client for the wallet-forensics job.
 *  ---------------------------------------------------------------------------
 *  Polymarket's public Gamma / Data / CLOB endpoints need no credentials (same
 *  endpoints the Surveillance tab uses). This module enumerates RESOLVED markets
 *  over a rolling window, pulls wallet-level trades, and AGGREGATES BY WALLET —
 *  the forensics pivot: the unit is the bettor's whole record, not the market.
 *
 *  Resilience: per-request timeout, capped pagination, graceful degrade. Never
 *  throws to the caller — a failed fetch yields [] so the scanner can choose not
 *  to advance its watermark rather than corrupt state.
 * ========================================================================== */
"use strict";

const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------- category (artifact) --
 * Map Polymarket tags / question text to the artifact's category vocabulary.
 * Returns null for outcomes decided in public (sports / crypto price / weather)
 * where a betting edge is noise, not information — those are not scored. */
function category(tags, question) {
  const s = (tags.join(" ") + " " + question).toLowerCase();
  if (/\bsport|nfl|nba|mlb|nhl|ufc|soccer|football|basketball|tennis|golf|\bf1\b|match|league|playoff/.test(s)) return null;
  if (/crypto|bitcoin|\bbtc\b|ethereum|\beth\b|solana|token price|coin price/.test(s)) return "Crypto";
  if (/weather|temperature|hurricane|rainfall|climate/.test(s)) return null;
  if (/military|defense|defence|airstrike|troop|missile|war\b|nato|sanction|basing|carrier|drone strike/.test(s)) return "Military & Defense";
  if (/election|midterm|primary|ballot|electoral|turnout|runoff/.test(s)) return "Elections";
  if (/econom|inflation|\bcpi\b|\bfed\b|fomc|\bgdp\b|jobs report|payroll|unemploy|rate (cut|hike|decision)|interest rate|recession/.test(s)) return "Economics";
  if (/politic|president|senate|congress|governor|cabinet|nominee|impeach|resign|pardon|executive order|supreme court/.test(s)) return "Politics";
  if (/culture|entertain|movie|film|box office|oscar|grammy|award|album|streaming/.test(s)) return "Culture";
  if (/\bworld\b|geopolit|treaty|summit|ceasefire|peace deal|coup|foreign|diplomat/.test(s)) return "World";
  return "World";
}

function tagList(ev, m) {
  const tags = (ev && ev.tags) || (m && m.tags) || [];
  const out = [];
  if (Array.isArray(tags)) for (const t of tags) { const l = t && (t.label || t.slug || (typeof t === "string" ? t : null)); if (l) out.push(l); }
  if (m && m.category) out.push(m.category);
  if (ev && ev.category) out.push(ev.category);
  return out;
}
function isBinary(outcomes) {
  let arr = outcomes;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch (_) { return false; } }
  if (!Array.isArray(arr) || arr.length !== 2) return false;
  const set = arr.map((x) => String(x).trim().toLowerCase());
  return set.includes("yes") && set.includes("no");
}
// final settled prices [YES,NO] in {0,1}. 'YES' | 'NO' | null.
function resolvedWinner(m) {
  let op = m.outcomePrices;
  if (typeof op === "string") { try { op = JSON.parse(op); } catch (_) { op = null; } }
  if (Array.isArray(op) && op.length === 2) {
    const yes = num(op[0]), no = num(op[1]);
    if (yes >= 0.95 && no <= 0.05) return "YES";
    if (no >= 0.95 && yes <= 0.05) return "NO";
  }
  return null;
}

/* --------------------------------------------------- enumerate RESOLVED PM --
 * Paginate closed=true fully within the lookback. Returns one row per binary
 * resolved market with a clean winner: { cond, tokenId, question, url, category,
 * eventGroup, winner, resolvedMs }. */
async function enumResolved(opts) {
  const o = Object.assign({ lookbackDays: 90, maxPages: 40, pageDelayMs: 120 }, opts);
  const out = [];
  const cutoff = Date.now() - o.lookbackDays * 86400000;
  let offset = 0, pages = 0;
  do {
    const url = GAMMA + "/events?closed=true&archived=false&limit=100&offset=" + offset + "&order=endDate&ascending=false";
    const evs = await getJSON(url, { timeout: 9000 }).catch(() => null);
    const arr = Array.isArray(evs) ? evs : (evs && (evs.data || evs.events)) || [];
    if (!arr.length) break;
    let anyRecent = false;
    for (const ev of arr) {
      const evTags = tagList(ev, null);
      const slug = ev.slug || (ev.markets && ev.markets[0] && ev.markets[0].slug) || ("ev-" + (ev.id || offset));
      const evUrl = ev.slug ? "https://polymarket.com/event/" + ev.slug : "https://polymarket.com/markets";
      for (const m of (ev.markets || [])) {
        if (!isBinary(m.outcomes)) continue;
        const winner = resolvedWinner(m);
        if (winner == null) continue;
        const question = String(m.question || m.groupItemTitle || ev.title || "").trim();
        if (!question) continue;
        const resolvedMs = Date.parse(m.closedTime || ev.closedTime || m.endDate || ev.endDate || 0) || 0;
        if (resolvedMs && resolvedMs < cutoff) continue;
        if (resolvedMs) anyRecent = true;
        const cat = category(evTags.concat(tagList(null, m)), question);
        if (!cat) continue;
        let tokenId = null;
        if (m.clobTokenIds) { try { const ct = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds; tokenId = ct && ct[0]; } catch (_) {} }
        out.push({ cond: m.conditionId || null, tokenId, question, url: evUrl, category: cat, eventGroup: slug, winner, resolvedMs: resolvedMs || null });
      }
    }
    offset += 100; pages++;
    if (!anyRecent && pages >= 2) break;
    await sleep(o.pageDelayMs);
  } while (pages < o.maxPages);
  return out;
}

/* ------------------------------------------------------ trades for a market --
 * Full paginated trade list (each trade has proxyWallet, side, size, price,
 * outcome, timestamp, transactionHash). */
async function tradesForMarket(cond, opts) {
  const o = Object.assign({ maxTrades: 4000, pageDelayMs: 90 }, opts);
  const trades = [];
  let offset = 0, pages = 0;
  do {
    const d = await getJSON(DATA + "/trades?market=" + encodeURIComponent(cond) + "&limit=500&offset=" + offset, { timeout: 8000 }).catch(() => null);
    const arr = Array.isArray(d) ? d : (d && (d.data || d.trades)) || [];
    if (!arr.length) break;
    trades.push(...arr); offset += arr.length; pages++;
    if (arr.length < 500) break;
    await sleep(o.pageDelayMs);
  } while (trades.length < o.maxTrades && pages < 12);
  return trades;
}

// a wallet's first-ever Polymarket activity timestamp (seconds).
async function firstSeen(wallet) {
  if (!wallet) return null;
  const d = await getJSON(DATA + "/activity?user=" + encodeURIComponent(wallet) + "&limit=1&sortDirection=ASC", { timeout: 6000 }).catch(() => null);
  const arr = Array.isArray(d) ? d : (d && (d.data || d.activity)) || [];
  const t = arr[0] && num(arr[0].timestamp || arr[0].time || arr[0].ts);
  return t || null;
}

// outcome label a trade took, normalised to 'YES' | 'NO'.
function tradeOutcome(t) {
  const o = String(t.outcome != null ? t.outcome : (t.outcomeIndex === 0 ? "Yes" : t.outcomeIndex === 1 ? "No" : "")).trim().toLowerCase();
  if (o === "yes" || o === "0") return "YES";
  if (o === "no" || o === "1") return "NO";
  return o.toUpperCase();
}

/* ---------------------------------------------- aggregate one market by wallet
 * Collapse a market's trades into per-(wallet,outcome) positions. A wallet's
 * bet on a binary market is its NET position in the outcome it bought most of:
 *   stakeUsd  = Σ buy(size·price)            (cost basis)
 *   entry p   = size-weighted avg buy price  (implied prob at entry)
 *   won       = (position outcome == winner)
 *   held      = sold < 3% of bought shares before resolution
 * Returns a map address -> position. */
function aggregateMarket(market, trades) {
  const byKey = {};
  for (const t of trades) {
    const w = t.proxyWallet || t.user || t.maker || t.taker;
    if (!w) continue;
    const oc = tradeOutcome(t);
    if (oc !== "YES" && oc !== "NO") continue;
    const side = String(t.side || "").toUpperCase();
    const size = num(t.size), price = num(t.price), ts = num(t.timestamp || t.matchTime || t.time);
    if (!size) continue;
    const key = w + "|" + oc;
    const e = byKey[key] || (byKey[key] = { address: w, outcome: oc, boughtShares: 0, soldShares: 0, costUsd: 0, wsumPrice: 0, firstTs: Infinity, tx: null });
    if (side === "SELL") { e.soldShares += size; }
    else { e.boughtShares += size; e.costUsd += size * price; e.wsumPrice += size * price; if (ts && ts < e.firstTs) { e.firstTs = ts; e.tx = t.transactionHash || t.transaction_hash || e.tx; } }
  }
  // one bet per wallet = its dominant outcome position in this market
  const byWallet = {};
  for (const k of Object.keys(byKey)) {
    const e = byKey[k];
    if (e.boughtShares <= 0) continue;
    const prev = byWallet[e.address];
    if (!prev || e.costUsd > prev.costUsd) byWallet[e.address] = e;
  }
  const out = {};
  for (const addr of Object.keys(byWallet)) {
    const e = byWallet[addr];
    const entryPrice = e.boughtShares > 0 ? e.costUsd / e.boughtShares : 0;
    const held = e.soldShares < 0.03 * e.boughtShares;
    out[addr] = {
      cond: market.cond, tokenId: market.tokenId, question: market.question, url: market.url,
      category: market.category, eventGroup: market.eventGroup,
      entryPrice: Math.max(1e-4, Math.min(0.9999, entryPrice)),
      stakeUsd: Math.round(e.costUsd), outcome: e.outcome,
      won: e.outcome === market.winner, held,
      ts: isFinite(e.firstTs) ? e.firstTs : (market.resolvedMs ? Math.round(market.resolvedMs / 1000) : null),
      tx: e.tx || null,
    };
  }
  return out;
}

module.exports = {
  getJSON, sleep, enumResolved, tradesForMarket, firstSeen, aggregateMarket,
  category, resolvedWinner, isBinary, tradeOutcome,
  GAMMA, DATA, CLOB,
};
