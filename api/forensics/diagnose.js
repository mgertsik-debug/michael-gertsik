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
  let positions = [], utrades = [];
  try { positions = await poly.userPositions(addr); } catch (_) {}
  try { utrades = await poly.userTrades(addr); } catch (e) { return Object.assign(o, { error: "trades fetch failed: " + (e && e.message) }); }
  o.sources = {
    positions: positions.length,
    positionsResolvedParsed: positions.map(poly.positionToBet).filter(Boolean).length,
    trades: utrades.length,
    tradesInCatalog: utrades.filter((t) => catalog[t.conditionId || t.market || t.condition_id]).length,
  };

  // Authoritative record: full trade history joined to the resolved-market catalog.
  const bets = poly.buildUserRecord(utrades, catalog);
  o.resolvedBetsParsed = bets.length;
  const longshots = bets.filter((b) => b.entryPrice <= 0.35);
  o.longShotBets = longshots.length;
  o.sampleBets = longshots.slice(0, 8).map((b) => ({
    market: String(b.question).slice(0, 60), category: b.category,
    entryOdds: Math.round(b.entryPrice * 100) + "%", stake: "$" + b.stakeUsd, outcome: b.outcome, won: b.won,
  }));

  // run the real detector suite + fusion on the parsed record
  const agg = { address: addr, bets, firstSeenTs: null, fundingTs: null, priorTx: null };
  const { dets, f } = build.scoreAggregate(agg);
  o.detectors = {
    won: dets.won.hasData ? { n: dets.won.n, k: dets.won.k, p: dets.won.p, P: dets.won.P, improbText: dets.won.improbText, winRate: dets.won.winRate + "%" } : { hasData: false, reason: dets.won.reason },
    longshot: dets.longshot.hasData ? { meanOdds: Math.round(dets.longshot.mean * 100) + "%", fires: dets.longshot.fires } : { hasData: false },
    held: dets.held.hasData ? { rate: dets.held.h, fires: dets.held.fires } : { hasData: false },
    baseline: dets.baseline.hasData ? { winRate: dets.baseline.winRate + "%", baseline: dets.baseline.baseline + "%" } : { hasData: false },
  };
  o.fused = { tier: f.tier || "unflagged", fired: f.fired, agreeing: f.agreeing, improbText: f.improbText };
  o.verdict = !dets.won.hasData
    ? ("Not scoreable: " + (dets.won.reason || "fewer than 5 resolved long-shot bets") + " (parsed " + longshots.length + " long-shot bets).")
    : (f.tier && f.tier !== "unflagged"
        ? ("FLAGGED " + f.tier.toUpperCase() + " — won " + dets.won.k + " of " + dets.won.n + " long-shots (~" + Math.round(dets.won.p * 100) + "% implied); chance by luck " + dets.won.improbText + "; " + f.fired.length + " detectors fired.")
        : ("Not flagged — won " + dets.won.k + " of " + dets.won.n + " long-shots; chance by luck " + dets.won.improbText + " does not clear the bar (or <2 detectors agree)."));
  return o;
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
  const user = q.user || (String(req.url || "").match(/[?&]user=([^&]+)/) || [])[1];
  try {
    if (user) { res.status(200).json(await scoreWallet(decodeURIComponent(String(user)).toLowerCase())); return; }
    res.status(200).json(await diagnose());
  } catch (e) { res.status(200).json({ verdict: "diagnose failed", error: String(e && e.message) }); }
};
module.exports.diagnose = diagnose;
