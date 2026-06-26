/* ============================================================================
 *  /api/forensics/diagnose — prove the wallet-forensics data path is real.
 *  ---------------------------------------------------------------------------
 *    GET /api/forensics/diagnose
 *
 *  The entire engine depends on Polymarket's Data API returning a TRADER
 *  ADDRESS per trade. This endpoint settles that live, with no trust in a code
 *  read: it enumerates one resolved market, pulls its real trades, and reports
 *
 *    1. which address field is present on a trade row (proxyWallet / user / …),
 *    2. whether the on-chain tx hash + entry price + size are present,
 *    3. the result of running the ACTUAL aggregateMarket() pipeline — how many
 *       distinct wallets it produced and a sample per-wallet position (address,
 *       entry odds, stake, outcome, won, tx) — i.e. exactly what the detector
 *       suite consumes,
 *    4. a one-line verdict: addressesPresent true/false + the field used.
 *
 *  Addresses in the sample are shortened (0x1234…abcd); the full address is
 *  public on-chain data but there's no reason to dump it here. Read-only,
 *  no secrets, no state writes.
 * ========================================================================== */
"use strict";
const poly = require("./poly.js");
const build = require("./build.js");
const D = require("./detectors.js");

const short = (a) => (a && a.length > 10 ? a.slice(0, 6) + "…" + a.slice(-4) : (a || null));
const ADDRESS_FIELDS = ["proxyWallet", "user", "maker", "taker", "wallet", "address", "trader"];

// Score ANY Polymarket wallet's full record live — the engine made inspectable.
// GET /api/forensics/diagnose?user=0x...  → the parsed long-shot record + every
// detector's verdict + the fused tier. Lets anyone point the engine at a wallet
// they suspect and see exactly what it computes (real data, no store needed).
function loadCatalog() {
  try { return require("../../data/forensics/markets.json"); } catch (_) {}
  try { return JSON.parse(require("fs").readFileSync(require("path").resolve(__dirname, "../../data/forensics/markets.json"), "utf8")); } catch (_) { return {}; }
}

async function scoreWallet(addr) {
  const o = { user: addr, checkedAt: new Date().toISOString() };
  const catalog = loadCatalog();
  o.catalogSize = Object.keys(catalog).length;

  // Data-source probe: show what each Polymarket feed returns for this wallet, so
  // the source of truth is verifiable rather than assumed.
  let utrades = [];
  try { utrades = await poly.userTrades(addr); } catch (e) { return Object.assign(o, { error: "trades fetch failed: " + (e && e.message) }); }

  // SELF-SUFFICIENT lookup: resolve markets the scan catalog hasn't reached yet
  // on-demand from Gamma, so any wallet scores fully right now — not only the
  // ones the sweep happens to have cataloged.
  const condOf = (t) => t.conditionId || t.market || t.condition_id;
  const inCat = (c) => !!catalog[c];
  const missing = Array.from(new Set(utrades.map(condOf).filter((c) => c && !inCat(c))));
  let onDemand = {};
  if (missing.length) { try { onDemand = await poly.marketsByConds(missing); } catch (_) {} }
  const merged = Object.assign({}, catalog, onDemand);

  // Build the record from BOTH sources and merge by market (dedup by cond):
  //  (a) /positions — self-resolving (curPrice gives the winner), no catalog needed;
  //  (b) /trades joined to the (catalog ∪ on-demand) resolved-market map.
  // Either alone is incomplete, together they cover redeemed + held positions.
  let posBets = [];
  try { posBets = (await poly.userPositions(addr)).map(poly.positionToBet).filter(Boolean); } catch (_) {}
  const recBets = poly.buildUserRecord(utrades, merged);
  const byCond = {};
  posBets.forEach((b) => { byCond[b.cond] = b; });          // authoritative first (real avg price + P/L)
  recBets.forEach((b) => { if (!byCond[b.cond]) byCond[b.cond] = b; });  // fill gaps from trades+catalog
  const allBets = Object.values(byCond);
  // SCOPE GATE (lookup side): the trades→catalog path still LABELS out-of-scope
  // markets (marketsByConds falls back to "Sports"/"Crypto"/"Other"); drop them so
  // the lookup scores the same in-scope universe as the scanner. Only markets that
  // can turn on nonpublic info are scored — sports/crypto/weather are decided in
  // public. This is why a pure sports sharp (swisstony, +$13M on World-Cup NO bets)
  // must come back as "out of scope", not as a long-shot loser.
  const OUT_OF_SCOPE = new Set(["Sports", "Crypto", "Weather", "Other"]);
  const bets = allBets.filter((b) => b && b.category && !OUT_OF_SCOPE.has(b.category));
  const outOfScope = allBets.length - bets.length;

  o.sources = {
    trades: utrades.length,
    catalogSize: o.catalogSize,
    resolvedOnDemand: Object.keys(onDemand).length,
    fromPositions: posBets.length,
    fromTradesCatalog: recBets.length,
    tradesResolvable: utrades.filter((t) => merged[condOf(t)]).length,
    resolvedTotal: allBets.length,
    outOfScope,
  };
  o.resolvedBetsParsed = bets.length;

  // ---- ALWAYS-ON PROFILE: any wallet's full resolved record, all odds ----
  // So you can look up literally anyone and see their score, not just long-shot
  // specialists. This is descriptive (their actual record), never a flag.
  const wins = bets.filter((b) => b.won).length;
  const profit = bets.reduce((a, b) => a + build.betPL(b), 0);
  const avgOdds = bets.length ? bets.reduce((a, b) => a + b.entryPrice, 0) / bets.length : 0;
  const longshots = bets.filter((b) => b.entryPrice <= 0.35);
  const lsWins = longshots.filter((b) => b.won).length;
  o.longShotBets = longshots.length;
  o.profile = {
    resolvedBets: bets.length,
    wins, winRate: bets.length ? Math.round((wins / bets.length) * 100) + "%" : "—",
    profit: build.signedMoney(profit), profitNum: Math.round(profit),
    avgOdds: bets.length ? Math.round(avgOdds * 100) + "%" : "—",
    longShotBets: longshots.length,
    longShotWinRate: longshots.length ? Math.round((lsWins / longshots.length) * 100) + "%" : "—",
  };
  // Render a bet into the row shape the UI ledger reads: real date, real entry
  // odds, real stake, real P/L, and the real on-chain tx (linkable to Polygonscan).
  const fmtDate = (ts) => {
    if (!ts) return "—";
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()] + " " +
      String(d.getUTCDate()).padStart(2, "0") + " " + d.getUTCFullYear();
  };
  const row = (b) => {
    const pl = build.betPL(b);
    return {
      market: String(b.question || "(market)"), url: b.url || null, category: b.category,
      date: fmtDate(b.ts || (b.resolvedMs ? b.resolvedMs / 1000 : null)), ts: b.ts || null,
      entryOdds: Math.round(b.entryPrice * 100) + "%", oddsNum: Math.round(b.entryPrice * 100),
      stake: "$" + (b.stakeUsd != null ? b.stakeUsd.toLocaleString("en-US") : "0"),
      outcome: b.outcome, won: b.won,
      pl: (pl >= 0 ? "+$" : "−$") + Math.abs(Math.round(pl)).toLocaleString("en-US"), plNum: Math.round(pl),
      tx: b.tx ? (b.tx.slice(0, 8) + "…" + b.tx.slice(-4)) : null, txFull: b.tx || null,
    };
  };
  // full ledger (in-scope, resolved), newest first — every position, not a preview
  o.ledger = bets.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(row);
  // sample: long-shots first (the interesting ones), else any resolved bets — biggest stakes
  o.sampleBets = (longshots.length ? longshots : bets).slice()
    .sort((a, b) => b.stakeUsd - a.stakeUsd).slice(0, 8).map(row);

  // ---- FORENSIC LAYER: the long-shot improbability flag, when computable ----
  const agg = { address: addr, bets, firstSeenTs: null, fundingTs: null, priorTx: null };
  const { dets, f } = build.scoreAggregate(agg);
  o.detectors = {
    won: dets.won.hasData ? { n: dets.won.n, k: dets.won.k, p: dets.won.p, P: dets.won.P, improbText: dets.won.improbText, winRate: dets.won.winRate + "%" } : { hasData: false, reason: dets.won.reason },
    longshot: dets.longshot.hasData ? { meanOdds: Math.round(dets.longshot.mean * 100) + "%", fires: dets.longshot.fires } : { hasData: false },
    held: dets.held.hasData ? { rate: dets.held.h, fires: dets.held.fires } : { hasData: false },
    baseline: dets.baseline.hasData ? { winRate: dets.baseline.winRate + "%", baseline: dets.baseline.baseline + "%" } : { hasData: false },
  };
  o.fused = { tier: f.tier || "unflagged", fired: f.fired, agreeing: f.agreeing, improbText: f.improbText };

  const p = o.profile;
  if (bets.length === 0) {
    o.verdict = outOfScope > 0
      ? ("Out of scope — this wallet's " + allBets.length + " resolved position" + (allBets.length === 1 ? "" : "s") +
         " are all in sports / crypto / price markets, which are decided in public, not by nonpublic information. This tool only scores markets where an information edge is possible (elections, military, economics, policy), so no informed-trading signal can be computed for this wallet.")
      : ("No resolved in-scope bets found for this wallet (" + utrades.length + " trades pulled, " + o.sources.tradesResolvable +
         " in resolved markets). It may be new, hold only still-open positions, or trade only non-binary / out-of-scope markets.");
  } else if (!dets.won.hasData) {
    o.verdict = "Record: " + p.resolvedBets + " resolved bets · " + p.winRate + " win rate · " + p.profit + " profit · avg odds " + p.avgOdds + ". " +
      "Only " + longshots.length + " long-shot bet" + (longshots.length === 1 ? "" : "s") + " (need 5+) — so no improbability flag, but the full record is shown.";
  } else if (f.tier && f.tier !== "unflagged") {
    o.verdict = "FLAGGED " + f.tier.toUpperCase() + " — won " + dets.won.k + " of " + dets.won.n + " long-shots (~" + Math.round(dets.won.p * 100) +
      "% implied); chance by luck " + dets.won.improbText + "; " + f.fired.length + " detectors fired. (" + p.resolvedBets + " total bets · " + p.profit + " profit.)";
  } else {
    o.verdict = "Not flagged — " + p.resolvedBets + " resolved bets · " + p.winRate + " win rate · " + p.profit + " profit. Won " + dets.won.k + " of " +
      dets.won.n + " long-shots; chance by luck " + dets.won.improbText + " does not clear the bar.";
  }

  // Full dossier subject (the tab's flagged shape) when it clears the bar.
  if (dets.won.hasData) {
    try { const subj = build.buildSubject(agg, 0, {}); if (subj) { build.derive([subj]); o.subject = subj; } } catch (_) {}
  }
  return o;
}

// RAW PROBE — return Polymarket's ACTUAL API responses verbatim (first rows), so
// the real field names/shape are visible and the parser can be mapped to reality
// instead of assumptions. GET /api/forensics/diagnose?user=0x...&raw=1
async function rawProbe(addr) {
  const DATA = "https://data-api.polymarket.com";
  const get = async (url) => {
    try {
      const r = await fetch(url, { signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 9000); return c.signal; })() });
      const status = r.status;
      let body = null; try { body = await r.json(); } catch (_) { try { body = (await r.text()).slice(0, 400); } catch (__) {} }
      const arr = Array.isArray(body) ? body : (body && (body.data || body.positions || body.trades || body.activity)) || null;
      return { status, isArray: Array.isArray(body), count: Array.isArray(arr) ? arr.length : null,
        keys: Array.isArray(arr) && arr[0] ? Object.keys(arr[0]) : (body && typeof body === "object" ? Object.keys(body) : null),
        sample: Array.isArray(arr) ? arr.slice(0, 2) : body };
    } catch (e) { return { error: String(e && e.message || e) }; }
  };
  return {
    user: addr, checkedAt: new Date().toISOString(),
    note: "Raw Polymarket Data API responses (first rows) so the field mapping can be fixed to match reality.",
    positions: await get(DATA + "/positions?user=" + encodeURIComponent(addr) + "&limit=3"),
    trades: await get(DATA + "/trades?user=" + encodeURIComponent(addr) + "&limit=3"),
    activity: await get(DATA + "/activity?user=" + encodeURIComponent(addr) + "&limit=3"),
    value: await get(DATA + "/value?user=" + encodeURIComponent(addr)),
  };
}

async function diagnose() {
  const o = { endpoint: "data-api.polymarket.com/trades", checkedAt: new Date().toISOString() };

  // 1. one resolved market to probe
  let market = null;
  try {
    const markets = await poly.enumResolved({ lookbackDays: 120, maxPages: 2 });
    market = markets.find((m) => m.cond) || null;
    o.resolvedMarket = market
      ? { cond: market.cond, question: market.question.slice(0, 90), category: market.category, winner: market.winner, url: market.url }
      : null;
    o.enumeratedCount = markets.length;
  } catch (e) { o.resolvedMarket = { error: String(e && e.message) }; }
  if (!market) { o.verdict = "could not enumerate a resolved market to probe (network/policy?)"; return o; }

  // 2. real trades for that market — the address-bearing rows
  let trades = [];
  try { trades = await poly.tradesForMarket(market.cond, { maxTrades: 500 }); }
  catch (e) { o.trades = { error: String(e && e.message) }; }

  if (!trades.length) { o.trades = { count: 0 }; o.verdict = "trades endpoint returned no rows for this market"; return o; }

  const t0 = trades[0];
  const tradeKeys = Object.keys(t0);
  const addressField = ADDRESS_FIELDS.find((f) => t0[f]) || null;
  o.trades = {
    count: trades.length,
    rowKeys: tradeKeys,
    addressFieldUsed: addressField,
    addressFieldsPresent: ADDRESS_FIELDS.filter((f) => t0[f]),
    hasTxHash: !!(t0.transactionHash || t0.transaction_hash),
    hasPrice: t0.price != null,
    hasSize: t0.size != null,
    hasOutcome: t0.outcome != null || t0.outcomeIndex != null,
    sampleRow: {
      address: short(t0[addressField]),
      side: t0.side, price: t0.price, size: t0.size,
      outcome: t0.outcome != null ? t0.outcome : t0.outcomeIndex,
      tx: short(t0.transactionHash || t0.transaction_hash),
      timestamp: t0.timestamp || t0.matchTime || t0.time,
    },
  };

  // 3. run the REAL aggregation the engine uses — proves per-wallet positions
  let topAddr = null;
  try {
    const positions = poly.aggregateMarket(market, trades);
    const addrs = Object.keys(positions);
    topAddr = addrs.slice().sort((a, b) => positions[b].stakeUsd - positions[a].stakeUsd)[0] || null;
    const top = topAddr ? positions[topAddr] : null;
    o.aggregation = {
      distinctWallets: addrs.length,
      samplePosition: top ? {
        address: short(topAddr),
        entryOdds: Math.round(top.entryPrice * 100) + "%",
        stakeUsd: top.stakeUsd, outcome: top.outcome, won: top.won, held: top.held,
        tx: short(top.tx), market: top.question.slice(0, 70),
      } : null,
    };
    // 4. is there enough here to actually flag a wallet? (one wallet won't, but
    //    this proves the shape the binomial consumes is real)
    o.engineReady = addrs.length > 0 && !!addressField && o.trades.hasPrice && o.trades.hasOutcome;
  } catch (e) { o.aggregation = { error: String(e && e.message) }; }

  // 5. wallet first-seen (the age/funding-recency input) for the top wallet
  try {
    if (topAddr) {
      const fs0 = await poly.firstSeen(topAddr);
      o.firstSeenProbe = { wallet: short(topAddr), firstSeenTs: fs0, ok: !!fs0 };
    }
  } catch (e) { o.firstSeenProbe = { error: String(e && e.message) }; }

  o.verdict = o.engineReady
    ? ("LIVE: trades carry a trader address (field: " + addressField + ") + price + outcome" + (o.trades.hasTxHash ? " + tx hash" : "") +
       "; aggregateMarket produced " + (o.aggregation && o.aggregation.distinctWallets) + " per-wallet positions. The single-wallet engine has everything it needs.")
    : ("INCOMPLETE: " + (!addressField ? "no recognised address field on trades — engine cannot key by wallet. " : "") +
       (!o.trades.hasPrice ? "no entry price. " : "") + (!o.trades.hasOutcome ? "no outcome. " : "") + "Inspect rowKeys above and adjust poly.js field mapping.");
  return o;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  const q = req.query || {};
  const url = String(req.url || "");
  const user = q.user || (url.match(/[?&]user=([^&]+)/) || [])[1];
  const raw = q.raw === "1" || q.raw === "true" || /[?&]raw=1/.test(url);
  try {
    if (user && raw) { res.status(200).json(await rawProbe(decodeURIComponent(String(user)).toLowerCase())); return; }
    if (user) { res.status(200).json(await scoreWallet(decodeURIComponent(String(user)).toLowerCase())); return; }
    res.status(200).json(await diagnose());
  } catch (e) { res.status(200).json({ verdict: "diagnose failed", error: String(e && e.message) }); }
};
module.exports.diagnose = diagnose;
module.exports.scoreWallet = scoreWallet;
module.exports.rawProbe = rawProbe;
