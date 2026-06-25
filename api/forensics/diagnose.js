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

const short = (a) => (a && a.length > 10 ? a.slice(0, 6) + "…" + a.slice(-4) : (a || null));
const ADDRESS_FIELDS = ["proxyWallet", "user", "maker", "taker", "wallet", "address", "trader"];

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
  try { res.status(200).json(await diagnose()); }
  catch (e) { res.status(200).json({ verdict: "diagnose failed", error: String(e && e.message) }); }
};
module.exports.diagnose = diagnose;
