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
  // ---- EXCLUDE: outcomes decided in PUBLIC — by skill on the field, by open price
  // discovery, or by nature. An "edge" there is handicapping/luck, not secret info. ----
  if (/\bsport|nfl|nba|wnba|mlb|nhl|\bufc\b|soccer|football|basketball|baseball|hockey|tennis|golf|\bf1\b|grand prix|\bmatch\b|\bgame\b|league|playoff|super ?bowl|world cup|lakers|celtics|yankees|warriors|chiefs|win game|moneyline|to score|goalscorer|points|rebounds|\bmvp\b/.test(s)) return null;
  // PRICE TARGETS only (pure price discovery). Crypto/stock EVENTS — listings, hacks,
  // ETF approvals — are insider-tradeable and caught in the INCLUDE block below.
  if (/price (of|target|above|below|reach|hit|prediction)|hit \$|reach \$|above \$|below \$|\$[0-9]|close (above|below)|all-time high|\bath\b|market ?cap|flippening|trade(s| at| above| below)/.test(s)) return null;
  if (/weather|temperature|hottest|coldest|hurricane|rainfall|snowfall|climate|\bel ni|degrees|\brain\b/.test(s)) return null;
  if (/\bmention|say the word|number of (posts|tweets|times)|how many (times|posts|tweets)|tweet count/.test(s)) return null;

  // ---- INCLUDE: outcomes that can turn on MATERIAL NONPUBLIC information ----
  // Military / national-security actions (operations, strikes, capture/seizure,
  // chokepoints) — the Maduro-capture / Iran-strike / Hormuz insider markets.
  if (/military|defense|defence|airstrike|air ?base|troop|missile|\bwar\b|warfare|nato|sanction|basing|carrier|drone|nuclear|ceasefire|hostage|strait|hormuz|blockade|invade|invasion|incursion|occupy|occupation|\bseize|\bcapture[d]?|operation|special forces|coup|overthrow|regime|airspace|strike on/.test(s)) return "Military & Defense";
  if (/election|midterm|primary|ballot|electoral|turnout|runoff/.test(s)) return "Elections";
  if (/econom|inflation|\bcpi\b|\bpce\b|\bfed\b|fomc|\bgdp\b|jobs report|payroll|unemploy|jobless|rate (cut|hike|decision)|interest rate|recession/.test(s)) return "Economics";
  // Legal / regulatory — verdicts, indictments, arrests, charges, rulings, approvals,
  // bans, investigations. Decided by bodies whose insiders know before the public.
  if (/\bindict|\bcharged?\b|\barrest|convict|acquit|verdict|\bguilty\b|sentenc|\bplea\b|lawsuit|\bsued?\b|settle(ment|s)?|subpoena|grand jury|\bsec\b|\bfda\b|\bftc\b|\bdoj\b|antitrust|regulat|\bapprov|\bban(ned|s)?\b|\bfine[ds]?\b|investigat|\bruling\b|\bcourt\b|\btrial\b|extradit|pardon|tariff|sanction/.test(s)) return "Legal & Regulatory";
  // Corporate / M&A — acquisitions, IPOs, bankruptcies, exec changes, layoffs. The
  // classic insider-trading surface.
  if (/acquir|acquisition|\bmerger\b|merge with|buyout|takeover|\bipo\b|go public|bankrupt|chapter 11|layoff|\bceo\b|\bcfo\b|step down as|fired as|resign as|\bearnings\b|delist|spin ?off|stock split|dividend|guidance|\bfunding round|valuation/.test(s)) return "Corporate & M&A";
  // Politics + LEADERSHIP TENURE — "X out by DATE", ousted, removed from power, survive.
  if (/politic|president|prime minister|\bpm\b|chancellor|senate|congress|governor|cabinet|nominee|confirm|impeach|resign|pardon|executive order|supreme court|\bout (by|in|before)\b|step down|leave office|leaves office|removed from|remain in office|stay in power|stays in power|ousted|ouster|\boust\b|in power|survive|toppl|in office/.test(s)) return "Politics";
  // Crypto EVENTS (not price) — listings, hacks, ETF approvals, protocol/governance.
  if (/list(ing|ed|s)?\b|\bdelist|\bhack|exploit|drained|\betf\b|spot etf|rug ?pull|depeg|insolven|halt withdrawals|mainnet|hard fork|governance vote|\bairdrop|token unlock|coinbase|binance|kraken|\bgemini\b/.test(s)) return "Crypto Events";
  // Tech / product announcements — launches, releases, unveilings decided internally.
  if (/\bannounc|unveil|\blaunch|release date|\breveal|\bgpt-?[0-9]|\bai model|new model|partnership|integration|\bships?\b in/.test(s)) return "Tech & Announcements";
  if (/culture|entertain|\bmovie|\bfilm\b|box office|oscar|grammy|emmy|\baward|\balbum\b|streaming chart|number one|\bnetflix\b|renew(ed|al)/.test(s)) return "Culture";
  // Geopolitics — named theatres + diplomacy (Venezuela/Maduro, Iran, Ukraine, etc.).
  if (/geopolit|treaty|summit|peace deal|coup|foreign|diplomat|annex|\bborder\b|maduro|venezuela|caracas|\biran\b|tehran|israel|gaza|hezbollah|hamas|ukraine|russia|kremlin|putin|taiwan|north korea|\bdprk\b|kim jong|syria|lebanon|yemen/.test(s)) return "World";
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

// On-demand resolution: given conditionIds, return a catalog {cond:{w,q,s,c,r}}
// for the ones that are settled binary markets. Uses the CLOB per-market endpoint
// (clob.polymarket.com/markets/<conditionId>), which returns each token with a
// `winner` flag once resolved — reliable per-condition, unlike a Gamma bulk
// filter. Small bounded concurrency so a heavy wallet resolves within budget.
async function marketsByConds(conds, opts) {
  const o = Object.assign({ maxConds: 150, concurrency: 6, pageDelayMs: 25 }, opts);
  const out = {};
  const list = Array.from(new Set((conds || []).filter(Boolean))).slice(0, o.maxConds);
  const one = async (cond) => {
    // try CLOB first, then Gamma's single-market filter as a backstop
    let m = await getJSON(CLOB + "/markets/" + encodeURIComponent(cond), { timeout: 7000 }).catch(() => null);
    let winner = null, q = "", slug = "", endIso = null;
    if (m && Array.isArray(m.tokens) && m.tokens.length === 2) {
      const set = m.tokens.map((t) => String(t.outcome || "").trim().toLowerCase());
      if (set.includes("yes") && set.includes("no")) {
        const win = m.tokens.find((t) => t.winner === true || t.winner === "true");
        if (win && (m.closed === true || m.closed === "true")) {
          winner = String(win.outcome).trim().toLowerCase() === "yes" ? "YES" : "NO";
          q = String(m.question || "").trim(); slug = m.market_slug || m.slug || ""; endIso = m.end_date_iso || m.endDate;
        }
      }
    }
    if (winner == null) {                                   // Gamma backstop
      const g = await getJSON(GAMMA + "/markets?condition_ids=" + encodeURIComponent(cond), { timeout: 7000 }).catch(() => null);
      const arr = Array.isArray(g) ? g : (g && (g.data || g.markets)) || [];
      const gm = arr[0];
      if (gm && isBinary(gm.outcomes)) { const w = resolvedWinner(gm); if (w != null) { winner = w; q = String(gm.question || "").trim(); slug = gm.slug || ""; endIso = gm.closedTime || gm.endDate; } }
    }
    if (winner == null) return;
    out[cond] = { w: winner, q, s: slug, c: category([], q) || categoryFallback(q), r: Math.round((Date.parse(endIso || 0) || 0) / 1000) || null };
  };
  for (let i = 0; i < list.length; i += o.concurrency) {
    await Promise.all(list.slice(i, i + o.concurrency).map(one));
    await sleep(o.pageDelayMs);
  }
  return out;
}

// OPEN-market metadata by condition (for the live watchlist). Gamma carries the real question,
// event SLUG (→ a working market link), and tags (→ our category). category() returns null for
// publicly-decided markets (sports / crypto-price / weather), which the watchlist uses to DROP them.
// Returns { cond: { question, slug, category, closed } } — bounded + concurrency-limited.
async function openMarketMeta(conds, opts) {
  const o = Object.assign({ maxConds: 18, concurrency: 5 }, opts);
  const out = {};
  const list = Array.from(new Set((conds || []).filter(Boolean))).slice(0, o.maxConds);
  const one = async (cond) => {
    const g = await getJSON(GAMMA + "/markets?condition_ids=" + encodeURIComponent(cond), { timeout: 6000 }).catch(() => null);
    const arr = Array.isArray(g) ? g : (g && (g.data || g.markets)) || [];
    const m = arr[0];
    if (!m) return;
    const tags = tagList(null, m);
    const slug = m.slug || (Array.isArray(m.events) && m.events[0] && m.events[0].slug) || "";
    out[cond] = { question: String(m.question || "").trim(), slug, category: category(tags, m.question), closed: m.closed === true || m.closed === "true" };
  };
  for (let i = 0; i < list.length; i += o.concurrency) await Promise.all(list.slice(i, i + o.concurrency).map(one));
  return out;
}

// EVERY trade a wallet ever made (rows shaped like tradesForMarket). Tries the
// /trades?user= endpoint first, then falls back to /activity?user= (TRADE
// events) — Polymarket exposes a wallet's history under different paths, so we
// try both and merge, deduped by tx+market, to be robust to either.
async function userTrades(wallet, opts) {
  const o = Object.assign({ maxTrades: 6000, pageDelayMs: 80 }, opts);
  if (!wallet) return [];
  const norm = (t) => ({
    conditionId: t.conditionId || t.market || t.condition_id || t.asset,
    side: t.side, size: t.size, price: t.price,
    outcome: t.outcome, outcomeIndex: t.outcomeIndex,
    timestamp: t.timestamp || t.matchTime || t.time,
    transactionHash: t.transactionHash || t.transaction_hash || t.txHash,
  });
  async function page(url) {
    const rows = [];
    let offset = 0, pages = 0;
    do {
      const d = await getJSON(url + "&limit=500&offset=" + offset, { timeout: 8000 }).catch(() => null);
      const arr = Array.isArray(d) ? d : (d && (d.data || d.trades || d.activity)) || [];
      if (!arr.length) break;
      rows.push(...arr); offset += arr.length; pages++;
      if (arr.length < 500) break;
      await sleep(o.pageDelayMs);
    } while (rows.length < o.maxTrades && pages < 16);
    return rows;
  }
  // CRITICAL SAFETY: /trades?user= returns GLOBAL recent trades when the user
  // filter doesn't take (confirmed via raw probe) — so we MUST keep only rows
  // whose proxyWallet matches the requested address, or we'd score a mix of
  // other people's trades as one wallet. owner() reads the trade's wallet.
  const lcw = String(wallet).toLowerCase();
  const owner = (t) => String(t.proxyWallet || t.user || t.maker || t.taker || t.owner || "").toLowerCase();
  const mine = (rows) => rows.filter((t) => owner(t) === lcw);

  let raw = mine(await page(DATA + "/trades?user=" + encodeURIComponent(wallet) + "&takerOnly=false"));
  if (!raw.length) {
    const act = await page(DATA + "/activity?user=" + encodeURIComponent(wallet) + "&type=TRADE");
    raw = mine(act.filter((a) => !a.type || String(a.type).toUpperCase() === "TRADE"));
  }
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const n = norm(t);
    const key = (n.transactionHash || "") + "|" + (n.conditionId || "") + "|" + (n.outcome || "") + "|" + (n.size || "");
    if (seen.has(key)) continue; seen.add(key);
    out.push(n);
  }
  return out;
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
      cond, eventGroup: m.s || cond, question: m.q || null,
      url: m.s ? "https://polymarket.com/event/" + m.s : null,
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
  // This path exists to recover a wallet's biggest WINNER for reconciliation, so the cap is
  // generous (4000 positions / 8 pages); the loop still exits early on the first short page,
  // so heavy wallets aren't silently truncated below their winning position.
  const o = Object.assign({ maxPositions: 4000, pageDelayMs: 80 }, opts);
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
  } while (out.length < o.maxPositions && pages < 8);
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
  // STAKE in USD cost-basis. initialValue is Polymarket's documented USD cost field;
  // totalBought is commonly cumulative SHARES (would inflate the stake ~1/price, e.g. ~9×
  // on an 11% long-shot), so it is NOT trusted here. Fall back to size·avgPrice (also USD).
  const totalBought = num(p.initialValue != null ? p.initialValue : size * avg);
  const title = String(p.title || p.question || "").trim();
  // SETTLED only when Polymarket marks the position REDEEMABLE — i.e. the market
  // resolved on-chain and the held tokens can be redeemed. Price is NOT a reliable
  // resolution signal: an open 2028-election long-shot sits at curPrice≈0.01 and a
  // heavy favourite at ≈0.99 for months while still fully tradable. Counting those
  // priced-extreme OPEN positions as "resolved losses" is what filled lookups with
  // future markets ("Tim Walz win 2028") shown as settled. Losing resolved bets
  // come from the trades→winner-catalog path instead (which also carries the tx).
  const settled = p.redeemable === true;
  if (!cond || !settled) return null;
  if (!(avg > 0.0001 && avg < 0.9999)) return null;            // need a real entry odds
  // SCOPE GATE: only markets whose outcome can turn on NONPUBLIC information are
  // scored. Sports / crypto / weather are decided in public (on the field, by price
  // discovery) — an edge there is noise, not informed trading — so they are excluded
  // from the forensic record entirely, not merely down-weighted. category() returns
  // null for those (and for unmatched markets); null ⇒ drop the bet.
  const cat = category([], title);
  if (!cat) return null;
  // Polymarket's OWN realized P/L for this position — authoritative, matches the
  // number on the wallet's Polymarket profile. Prefer it over any reconstruction.
  const pnl = p.cashPnl != null ? num(p.cashPnl) : (p.realizedPnl != null ? num(p.realizedPnl) : null);
  // WON: curPrice is the HELD outcome's current price (NO held at avg 0.542 → curPrice
  // 0.622 → +14.7%). For a resolved binary that price is ~0 or ~1, so ≥0.5 means the held
  // side WON. But a MISSING curPrice must NOT silently read as a loss — reconcile with the
  // authoritative realized P/L instead, and if neither is available leave won UNDETERMINED
  // (null) so the bet degrades to "no data" rather than a fabricated loss.
  const hasCur = (p.curPrice != null || p.cur_price != null);
  const won = hasCur ? cur >= 0.5 : (pnl != null ? pnl > 0 : null);
  const endMs = Date.parse(p.endDate || p.end_date || 0) || 0;
  const evSlug = p.eventSlug || p.slug;                        // event slug drives the canonical market URL
  return {
    cond, eventGroup: evSlug || cond, question: title || null,
    url: evSlug ? "https://polymarket.com/event/" + evSlug : null,
    category: cat, entryPrice: clip(avg, 1e-4, 0.9999), stakeUsd: Math.round(totalBought || size * avg),
    outcome: String(p.outcome || "").toUpperCase() || null, won, held: true,
    pnl: pnl != null ? Math.round(pnl) : null,
    ts: endMs ? Math.round(endMs / 1000) : null, tx: null, resolvedMs: endMs || null,
    source: "positions",
  };
}

// LIVE DISCOVERY FEED — the most recent trades across ALL of Polymarket (no user
// filter), newest first. This is how brand-new wallets are seen the MOMENT they
// trade, instead of only when the resolved-market sweep eventually reaches their
// markets. Returns raw trade rows (proxyWallet, conditionId, price, outcome, ts…).
// Paginated + bounded so a tick stays within budget.
async function recentTrades(opts) {
  const o = Object.assign({ pages: 12, limit: 500, pageDelayMs: 70, maxRows: 6000 }, opts);
  const out = [];
  let offset = 0;
  for (let p = 0; p < o.pages && out.length < o.maxRows; p++) {
    const d = await getJSON(DATA + "/trades?limit=" + o.limit + "&offset=" + offset + "&takerOnly=false", { timeout: 8000 }).catch(() => null);
    const arr = Array.isArray(d) ? d : (d && (d.data || d.trades)) || [];
    if (!arr.length) break;
    out.push(...arr); offset += arr.length;
    if (arr.length < o.limit) break;
    await sleep(o.pageDelayMs);
  }
  return out;
}

// Polymarket's OWN profile aggregates — the exact headline numbers their profile
// page shows — so the lookup MIRRORS Polymarket instead of reconstructing. Verified
// against live responses: user-pnl last point = all-time P/L (matched swisstony's
// $13,766,411 exactly); /traded = prediction count; lb-api profit/volume = all-time;
// /value = current portfolio value; lb-api carries the username/pseudonym.
async function profileAggregates(wallet) {
  if (!wallet) return null;
  const w = encodeURIComponent(wallet);
  const PNL = "https://user-pnl-api.polymarket.com", LB = "https://lb-api.polymarket.com";
  const [val, pnl, profit, vol, traded] = await Promise.all([
    getJSON(DATA + "/value?user=" + w, { timeout: 7000 }).catch(() => null),
    getJSON(PNL + "/user-pnl?user_address=" + w + "&interval=all&fidelity=1d", { timeout: 7000 }).catch(() => null),
    getJSON(LB + "/profit?window=all&limit=1&address=" + w, { timeout: 7000 }).catch(() => null),
    getJSON(LB + "/volume?window=all&limit=1&address=" + w, { timeout: 7000 }).catch(() => null),
    getJSON(DATA + "/traded?user=" + w, { timeout: 7000 }).catch(() => null),
  ]);
  const arr = (x) => (Array.isArray(x) ? x : (x ? [x] : []));
  const last = arr(pnl).length ? arr(pnl)[arr(pnl).length - 1] : null;
  const p0 = arr(profit)[0] || {};
  const v0 = arr(val)[0] || {};
  const vol0 = arr(vol)[0] || {};
  const pnlAll = last && last.p != null ? num(last.p) : (p0.amount != null ? num(p0.amount) : null);
  return {
    username: p0.name || p0.pseudonym || null,
    value: v0.value != null ? num(v0.value) : null,
    pnlAllTime: pnlAll,
    volume: vol0.amount != null ? num(vol0.amount) : null,
    traded: traded && traded.traded != null ? num(traded.traded) : null,
  };
}

// A wallet's first-ever Polymarket activity timestamp (seconds) = the date the dossier shows
// as "first active on Polymarket". We MUST sort by TIMESTAMP explicitly: with only
// sortDirection=ASC the API could order by a different default field, making arr[0] not the
// chronologically earliest action and the displayed date wrong. To be doubly safe against an
// unsupported sort param, we also scan the returned rows for the true minimum timestamp.
async function firstSeen(wallet) {
  if (!wallet) return null;
  const d = await getJSON(DATA + "/activity?user=" + encodeURIComponent(wallet) + "&limit=20&sortBy=TIMESTAMP&sortDirection=ASC", { timeout: 6000 }).catch(() => null);
  const arr = Array.isArray(d) ? d : (d && (d.data || d.activity)) || [];
  let min = null;
  for (const a of arr) {
    const t = num(a && (a.timestamp || a.time || a.ts));
    if (t > 0 && (min == null || t < min)) min = t;             // true earliest, regardless of server sort
  }
  return min || null;
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
  const resolvedSec = market.resolvedMs ? Math.round(market.resolvedMs / 1000) : null;
  const LATE_WINDOW = 48 * 3600;                              // Harvard's pre-event window: final 48h
  // ANCHOR for the late-buy window. Harvard uses "the LAST TRADE timestamp as a proxy for the
  // event resolution time" — NOT the official resolution time (which can be set well after the
  // book goes quiet, which would over- or under-count late buys depending on the gap). Match the
  // paper exactly: anchor on the market's last trade; fall back to resolvedSec only if absent.
  let lastTradeTs = 0;
  for (const t of trades) { const ts = num(t.timestamp || t.matchTime || t.time); if (ts > lastTradeTs) lastTradeTs = ts; }
  const lateAnchor = lastTradeTs || resolvedSec || null;
  // EVENT ANCHOR (price-shock): the timing detector should measure entries against WHEN THE INFO HIT
  // — the moment the market repriced — not the official resolution (which can lag the news by days).
  // We derive it from the SAME trade series already in hand: bin trades into hourly mean prices in
  // time order, and take the start of the bucket with the largest absolute price jump from the prior
  // bucket as the shock timestamp. HONEST CAVEAT: the trade sample is truncated, so this anchor is
  // approximate — but it still beats resolution-anchoring whenever resolution lags the event.
  const shockTs = (() => {
    const px = trades.map((t) => ({ ts: num(t.timestamp || t.matchTime || t.time), p: num(t.price) }))
      .filter((x) => x.ts > 0 && x.p > 0 && x.p < 1).sort((a, b) => a.ts - b.ts);
    if (px.length < 8) return null;                          // too few trades to locate a shock honestly
    const BUCKET = 3600;                                     // hourly buckets
    const buckets = new Map();
    for (const x of px) { const b = Math.floor(x.ts / BUCKET); const e = buckets.get(b) || { ts: b * BUCKET, sum: 0, n: 0 }; e.sum += x.p; e.n++; buckets.set(b, e); }
    const seq = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts).map((e) => ({ ts: e.ts, p: e.sum / e.n }));
    if (seq.length < 3) return null;
    let best = 0, bestTs = null;
    for (let i = 1; i < seq.length; i++) { const d = Math.abs(seq[i].p - seq[i - 1].p); if (d > best) { best = d; bestTs = seq[i].ts; } }
    return best >= 0.15 ? bestTs : null;                     // require a real repricing (≥15c move)
  })();
  for (const t of trades) {
    const w = t.proxyWallet || t.user || t.maker || t.taker;
    if (!w) continue;
    const oc = tradeOutcome(t);
    if (oc !== "YES" && oc !== "NO") continue;
    const side = String(t.side || "").toUpperCase();
    const size = num(t.size), price = num(t.price), ts = num(t.timestamp || t.matchTime || t.time);
    if (!size) continue;
    const key = w + "|" + oc;
    const e = byKey[key] || (byKey[key] = { address: w, outcome: oc, boughtShares: 0, soldShares: 0, costUsd: 0, lateUsd: 0, wsumPrice: 0, firstTs: Infinity, tx: null });
    if (side === "SELL") { e.soldShares += size; }
    else {
      e.boughtShares += size; e.costUsd += size * price; e.wsumPrice += size * price;
      if (lateAnchor && ts && (lateAnchor - ts) <= LATE_WINDOW && (lateAnchor - ts) >= 0) e.lateUsd += size * price;  // pre-event buy volume (final 48h before last trade)
      if (ts && ts < e.firstTs) { e.firstTs = ts; e.tx = t.transactionHash || t.transaction_hash || e.tx; }
    }
  }
  // one bet per wallet = its dominant outcome position in this market
  const byWallet = {};
  for (const k of Object.keys(byKey)) {
    const e = byKey[k];
    if (e.boughtShares <= 0) continue;
    const prev = byWallet[e.address];
    if (!prev || e.costUsd > prev.costUsd) byWallet[e.address] = e;
  }
  // ---- HARVARD per-market CROSS-SECTION: bet-size and profit z-scores vs all peers in
  // this market, plus the late-buy fraction and directional score (Ofir & Ofir 2026). Only
  // computed when the market clears Harvard's reference-distribution filters (≥3 buyers and
  // ≥$10k total buy volume); otherwise hz is null and the episode just isn't Harvard-scored.
  const ps = Object.keys(byWallet).map((addr) => {
    const e = byWallet[addr];
    const entry = clip(e.costUsd / e.boughtShares, 1e-4, 0.9999);
    const won = e.outcome === market.winner;
    const profit = won ? e.costUsd * (1 / entry - 1) : -e.costUsd;          // held-to-resolution reconstruction
    const lateFrac = e.costUsd > 0 ? clip(e.lateUsd / e.costUsd, 0, 1) : 0;
    // DIRECTIONAL CONCENTRATION (Harvard signal 5): 1.0 = pure one-sided buy-and-hold; lower
    // = the trader sold or HEDGED. On Polymarket an exit is recorded EITHER as a SELL of the
    // held token OR as a BUY of the COMPLEMENT token ("complement routing"). Counting only
    // outright sells pins dir at ~1 for nearly everyone (the bug that made every wallet look
    // like a pure-conviction holder). Net the complement-side buys in with the sells so a
    // hedged/exited position correctly scores below 1, matching Harvard's aggregate-fill basis.
    const compShares = (byKey[addr + "|" + (e.outcome === "YES" ? "NO" : "YES")] || {}).boughtShares || 0;
    const dir = e.boughtShares > 0 ? clip(1 - (e.soldShares + compShares) / e.boughtShares, 0, 1) : 0;
    return { addr, e, entry, won, profit, lateFrac, dir };
  });
  const stakes = ps.map((p) => p.e.costUsd), profits = ps.map((p) => p.profit);
  const totalVol = stakes.reduce((a, b) => a + b, 0), nBuyers = ps.length;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sd = (a, m) => (a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1)) : 0);
  const muS = mean(stakes), sdS = sd(stakes, muS), muP = mean(profits), sdP = sd(profits, muP);
  const eligible = nBuyers >= 3 && totalVol >= 10000;                       // Harvard market filters
  const out = {};
  for (const p of ps) {
    const e = p.e;
    out[p.addr] = {
      cond: market.cond, tokenId: market.tokenId, question: market.question, url: market.url,
      category: market.category, eventGroup: market.eventGroup,
      entryPrice: p.entry,
      stakeUsd: Math.round(e.costUsd), outcome: e.outcome,
      won: p.won, held: e.soldShares < 0.03 * e.boughtShares,
      ts: isFinite(e.firstTs) ? e.firstTs : (resolvedSec || null),
      shockTs: shockTs || null,                              // price-shock anchor for event-anchored timing
      tx: e.tx || null,
      // Harvard episode inputs (cross-sectional). z_bet_within is added later by build.js
      // from the wallet's full betting history (its own baseline across markets).
      // Harvard episode is scored only when the market clears ≥3 buyers AND ≥$10k vol AND
      // this wallet staked ≥$500 (the paper's per-wallet floor). When a market's stake or
      // profit dispersion is degenerate (sd=0) the z is UNMEASURABLE → null (not 0), so the
      // composite degrades to no-data instead of a fabricated 0-contribution signal.
      hz: (eligible && e.costUsd >= 500) ? {
        zBetCross: sdS > 0 ? +((e.costUsd - muS) / sdS).toFixed(3) : null,
        zProfitCross: sdP > 0 ? +((p.profit - muP) / sdP).toFixed(3) : null,
        lateBuyFraction: +p.lateFrac.toFixed(3),
        directionalScore: +p.dir.toFixed(3),
        marketVol: Math.round(totalVol), nBuyers,
      } : null,
    };
  }
  return out;
}

// pull a 0x proxy address out of an arbitrary profile JSON shape (proxy/wallet/address key)
function pickAddress(j) {
  const found = [];
  const visit = (o, d) => {
    if (!o || d > 5) return;
    if (Array.isArray(o)) return o.forEach((x) => visit(x, d + 1));
    if (typeof o === "object") for (const k in o) {
      const v = o[k];
      if (typeof v === "string" && /proxy|wallet|address/i.test(k) && /^0x[0-9a-fA-F]{40}$/.test(v)) found.push(v.toLowerCase());
      else if (v && typeof v === "object") visit(v, d + 1);
    }
  };
  visit(j, 0);
  return found[0] || null;
}
// BEST-EFFORT username -> proxy address. The named insider cases (Magamyman,
// AlphaRaccoon/@0xafee, romanticpaul, dirtycup, 6741) were reported by HANDLE, not
// address. Polymarket's username API isn't officially documented, so try a few
// plausible public endpoints and extract the proxy address; returns null on failure
// (no harm). Runs in the cron, where Polymarket is reachable.
async function resolveUsername(handle) {
  const h = String(handle || "").replace(/^@/, "").trim();
  if (!h) return null;
  const candidates = [
    GAMMA + "/profiles?username=" + encodeURIComponent(h),
    GAMMA + "/profiles?handle=" + encodeURIComponent(h),
    "https://polymarket.com/api/profile/" + encodeURIComponent(h),
    "https://lb-api.polymarket.com/profile?username=" + encodeURIComponent(h),
  ];
  for (const url of candidates) {
    try { const a = pickAddress(await getJSON(url, { timeout: 6000 })); if (a) return a; } catch (_) {}
  }
  return null;
}

module.exports = {
  getJSON, sleep, enumResolved, tradesForMarket, firstSeen, aggregateMarket, recentTrades, profileAggregates,
  userPositions, positionToBet, userTrades, buildUserRecord, marketsByConds, openMarketMeta, category, resolvedWinner, isBinary, tradeOutcome,
  resolveUsername, pickAddress, GAMMA, DATA, CLOB,
};
