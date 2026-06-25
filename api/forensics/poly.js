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
  // EXCLUDE outcomes decided in public / on the field / by price discovery — an
  // "edge" there is noise, not information.
  if (/\bsport|nfl|nba|wnba|mlb|nhl|\bufc\b|soccer|football|basketball|baseball|hockey|tennis|golf|\bf1\b|grand prix|\bmatch\b|\bgame\b|league|playoff|super ?bowl|world cup|lakers|celtics|yankees|warriors|chiefs|win game|moneyline|to score|goalscorer/.test(s)) return null;
  if (/crypto|bitcoin|\bbtc\b|ethereum|\beth\b|solana|\bsol\b|\bxrp\b|dogecoin|token price|coin price|price of|hit \$|reach \$/.test(s)) return null;
  if (/weather|temperature|hottest|hurricane|rainfall|snowfall|climate|\bel ni/.test(s)) return null;
  if (/\bmention|say the word|tweet|number of posts/.test(s)) return null;
  // INCLUDE only markets whose outcome can turn on nonpublic information.
  if (/military|defense|defence|airstrike|troop|missile|\bwar\b|nato|sanction|basing|carrier|drone strike|nuclear|ceasefire|hostage/.test(s)) return "Military & Defense";
  if (/election|midterm|primary|ballot|electoral|turnout|runoff/.test(s)) return "Elections";
  if (/econom|inflation|\bcpi\b|\bpce\b|\bfed\b|fomc|\bgdp\b|jobs report|payroll|unemploy|jobless|rate (cut|hike|decision)|interest rate|recession/.test(s)) return "Economics";
  if (/politic|president|senate|congress|governor|cabinet|nominee|confirm|impeach|resign|pardon|executive order|supreme court|indict|cabinet/.test(s)) return "Politics";
  if (/culture|entertain|\bmovie|\bfilm\b|box office|oscar|grammy|emmy|\baward|\balbum\b|streaming chart/.test(s)) return "Culture";
  if (/geopolit|treaty|summit|peace deal|coup|foreign|diplomat|sanction|annex|invade|border/.test(s)) return "World";
  return null;                                            // unmatched ⇒ not a detectable-edge market ⇒ excluded
}

// Best-effort label for a market the strict classifier didn't match, so the bet
// still counts toward the bettor's record. Sports/Crypto carry their own (low)
// baselines; everything else falls to "Other" (→ the global 14% baseline).
function categoryFallback(title) {
  const s = String(title || "").toLowerCase();
  if (/\bsport|nfl|nba|wnba|mlb|nhl|\bufc\b|soccer|football|basketball|baseball|hockey|tennis|golf|\bf1\b|grand prix|\bmatch\b|\bgame\b|league|playoff|lakers|celtics|yankees|warriors|chiefs/.test(s)) return "Sports";
  if (/crypto|bitcoin|\bbtc\b|ethereum|\beth\b|solana|\bsol\b|token|coin|price of|hit \$/.test(s)) return "Crypto";
  return "Other";
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
  const o = Object.assign({ lookbackDays: 90, maxPages: 40, pageDelayMs: 120, startOffset: 0, maxMarkets: Infinity }, opts);
  const out = [];
  const cutoff = Date.now() - o.lookbackDays * 86400000;
  let offset = o.startOffset || 0, pages = 0, exhausted = false;
  do {
    const url = GAMMA + "/events?closed=true&archived=false&limit=100&offset=" + offset + "&order=endDate&ascending=false";
    const evs = await getJSON(url, { timeout: 9000 }).catch(() => null);
    const arr = Array.isArray(evs) ? evs : (evs && (evs.data || evs.events)) || [];
    if (!arr.length) { exhausted = true; break; }            // reached the end of the closed-event list
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
    if (!anyRecent && pages >= 2) { exhausted = true; break; }  // walked past the lookback window
    if (out.length >= o.maxMarkets) break;                      // enough for this run; resume here next time
    await sleep(o.pageDelayMs);
  } while (pages < o.maxPages);
  // Back-compat: callers that ignore the return shape still get the array via .markets,
  // but the array itself is returned so existing `markets.length` style use keeps working.
  out.nextOffset = exhausted ? 0 : offset;     // 0 ⇒ wrap to the freshest events next sweep
  out.exhausted = exhausted;
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

// EVERY trade a wallet ever made (same row shape as tradesForMarket, by user).
// This is the complete, authoritative history — joined to the resolved-market
// catalog it yields the wallet's whole long-shot record in one pass.
async function userTrades(wallet, opts) {
  const o = Object.assign({ maxTrades: 6000, pageDelayMs: 80 }, opts);
  if (!wallet) return [];
  const trades = [];
  let offset = 0, pages = 0;
  do {
    const d = await getJSON(DATA + "/trades?user=" + encodeURIComponent(wallet) + "&limit=500&offset=" + offset, { timeout: 8000 }).catch(() => null);
    const arr = Array.isArray(d) ? d : (d && (d.data || d.trades)) || [];
    if (!arr.length) break;
    trades.push(...arr); offset += arr.length; pages++;
    if (arr.length < 500) break;
    await sleep(o.pageDelayMs);
  } while (trades.length < o.maxTrades && pages < 16);
  return trades;
}

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Build a wallet's resolved-bet record from its trades + a catalog of resolved
// markets (cond -> { w:'YES'|'NO', q, s, c, r }). One bet per (cond) = the
// wallet's net dominant-outcome position; won = that outcome matches the catalog
// winner. Markets not in the catalog are skipped (resolution unknown). This is
// the authoritative full record — known winners, real entry odds.
function buildUserRecord(trades, catalog) {
  const byKey = {};
  for (const t of (trades || [])) {
    const cond = t.conditionId || t.market || t.condition_id;
    if (!cond || !catalog[cond]) continue;
    const oc = tradeOutcome(t);
    if (oc !== "YES" && oc !== "NO") continue;
    const size = num(t.size), price = num(t.price), ts = num(t.timestamp || t.matchTime || t.time);
    const side = String(t.side || "").toUpperCase();
    if (!size) continue;
    const key = cond + "|" + oc;
    const e = byKey[key] || (byKey[key] = { cond, oc, bought: 0, sold: 0, cost: 0, firstTs: Infinity, tx: null });
    if (side === "SELL") e.sold += size;
    else { e.bought += size; e.cost += size * price; if (ts && ts < e.firstTs) { e.firstTs = ts; e.tx = t.transactionHash || t.transaction_hash || e.tx; } }
  }
  // pick the dominant outcome position per market
  const byCond = {};
  for (const k of Object.keys(byKey)) {
    const e = byKey[k]; if (e.bought <= 0) continue;
    if (!byCond[e.cond] || e.cost > byCond[e.cond].cost) byCond[e.cond] = e;
  }
  const bets = [];
  for (const cond of Object.keys(byCond)) {
    const e = byCond[cond], m = catalog[cond];
    const entry = e.cost / e.bought;
    if (!(entry > 0.0001 && entry < 0.9999)) continue;
    bets.push({
      cond, eventGroup: m.s || cond, question: m.q || "(market)",
      url: m.s ? "https://polymarket.com/event/" + m.s : "https://polymarket.com/markets",
      category: m.c || "Other", entryPrice: clip(entry, 1e-4, 0.9999), stakeUsd: Math.round(e.cost),
      outcome: e.oc, won: e.oc === m.w, held: e.sold < 0.03 * e.bought,
      ts: isFinite(e.firstTs) ? e.firstTs : (m.r || null), tx: e.tx || null, resolvedMs: m.r ? m.r * 1000 : null,
    });
  }
  return bets;
}

// A wallet's FULL position record (Data API /positions). This is the wallet
// pivot done right: one call returns every market the wallet took a position in,
// with entry price, size, and the settled outcome — so a screened wallet is
// scored on its WHOLE resolved record in one pass, not only the markets the
// market-sweep has reached. Paginated, guarded, returns [] on failure.
async function userPositions(wallet, opts) {
  const o = Object.assign({ maxPositions: 1500, pageDelayMs: 80 }, opts);
  if (!wallet) return [];
  const out = [];
  let offset = 0, pages = 0;
  do {
    const d = await getJSON(DATA + "/positions?user=" + encodeURIComponent(wallet) + "&limit=500&offset=" + offset, { timeout: 8000 }).catch(() => null);
    const arr = Array.isArray(d) ? d : (d && (d.data || d.positions)) || [];
    if (!arr.length) break;
    out.push(...arr); offset += arr.length; pages++;
    if (arr.length < 500) break;
    await sleep(o.pageDelayMs);
  } while (out.length < o.maxPositions && pages < 4);
  return out;
}

// Convert a /positions row into a resolved BET, or null if it is not a settled,
// binary, detectable-category long-shot we can score. A market is settled when
// its price has snapped to 0/1 (or it is redeemable / past its end date). Won
// when the held outcome settled to ~1. Entry odds = avgPrice (size-weighted).
function positionToBet(p) {
  if (!p) return null;
  const cond = p.conditionId || p.condition_id || p.market || p.asset || null;
  const avg = num(p.avgPrice != null ? p.avgPrice : p.avg_price);
  const cur = num(p.curPrice != null ? p.curPrice : p.cur_price);
  const size = num(p.size != null ? p.size : p.shares);
  const totalBought = num(p.totalBought != null ? p.totalBought : (p.initialValue != null ? p.initialValue : size * avg));
  const title = String(p.title || p.question || "").trim();
  const endMs = Date.parse(p.endDate || p.end_date || 0) || 0;
  const settled = cur <= 0.02 || cur >= 0.98 || p.redeemable === true || (endMs && endMs < Date.now());
  if (!cond || !settled) return null;
  if (!(avg > 0.0001 && avg < 0.9999)) return null;            // need a real entry odds
  // Label every settled market (Sports/Crypto included, "Other" when unknown) —
  // the bettor's improbability is computed over their whole long-shot record;
  // category drives the baseline/risk weight, it is NOT a gate that shrinks n.
  const cat = category([], title) || categoryFallback(title);
  const won = cur >= 0.5;
  return {
    cond, eventGroup: p.slug || cond, question: title || "(market)",
    url: p.slug ? "https://polymarket.com/event/" + p.slug : "https://polymarket.com/markets",
    category: cat, entryPrice: clip(avg, 1e-4, 0.9999), stakeUsd: Math.round(totalBought || size * avg),
    outcome: (String(p.outcome || "").toUpperCase()) || "YES", won, held: true,
    ts: endMs ? Math.round(endMs / 1000) : null, tx: null, resolvedMs: endMs || null,
  };
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
  userPositions, positionToBet, userTrades, buildUserRecord, category, resolvedWinner, isBinary, tradeOutcome,
  GAMMA, DATA, CLOB,
};
