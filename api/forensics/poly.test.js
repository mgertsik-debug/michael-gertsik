"use strict";
const test = require("node:test");
const assert = require("node:assert");
const poly = require("./poly.js");

// txMapFromTrades recovers the entry-tx hash for bets that come from the /positions
// summary feed (which has no per-trade hash). The rule must match buildUserRecord:
// the EARLIEST BUY for a (market, outcome), sells ignored, no-hash rows skipped.
test("txMapFromTrades: earliest BUY wins, sells ignored, hashless skipped", () => {
  const trades = [
    { conditionId: "0xAAA", side: "BUY", outcome: "Yes", timestamp: 200, transactionHash: "0xlate" },
    { conditionId: "0xAAA", side: "BUY", outcome: "Yes", timestamp: 100, transactionHash: "0xentry" },
    { conditionId: "0xAAA", side: "SELL", outcome: "Yes", timestamp: 50, transactionHash: "0xsell" },
    { conditionId: "0xBBB", side: "BUY", outcomeIndex: 1, timestamp: 300, transactionHash: "0xno" },
    { conditionId: "0xCCC", side: "BUY", outcome: "Yes", timestamp: 10 }, // no hash → not mapped
  ];
  const m = poly.txMapFromTrades(trades);
  assert.equal(m.byKey["0xAAA|YES"], "0xentry", "earliest BUY tx, not the later add or the sell");
  assert.equal(m.byKey["0xBBB|NO"], "0xno", "NO outcome resolved via outcomeIndex");
  assert.equal(m.byKey["0xCCC|YES"], undefined, "rows without a hash are not mapped");
  assert.equal(m.byCond["0xAAA"], "0xentry", "cond-only fallback also picks earliest BUY");
  assert.equal(m.byCond["0xCCC"], undefined, "cond-only fallback skips hashless markets too");
});

test("txMapFromTrades: empty / nullish input is safe", () => {
  assert.deepEqual(poly.txMapFromTrades(null), { byKey: {}, byCond: {} });
  assert.deepEqual(poly.txMapFromTrades([]), { byKey: {}, byCond: {} });
});

// Field-name robustness: Polymarket exposes the hash under several keys across its
// /trades and /activity endpoints; all must be honoured so the backfill works
// regardless of which path produced the rows.
test("txMapFromTrades: accepts transaction_hash and txHash aliases", () => {
  const m = poly.txMapFromTrades([
    { conditionId: "0xD", side: "BUY", outcome: "Yes", timestamp: 1, transaction_hash: "0xsnake" },
    { conditionId: "0xE", side: "BUY", outcome: "No", timestamp: 1, txHash: "0xcamel" },
  ]);
  assert.equal(m.byKey["0xD|YES"], "0xsnake");
  assert.equal(m.byKey["0xE|NO"], "0xcamel");
});

// ---------------------------------------------------------------------------
// aggregateMarket NET P&L. The reconstruction must report the money a wallet
// actually KEPT (proceeds from sells + $1 per winning share still HELD − total
// buy cost), and the bet size must be NET capital carried into the event (gross
// buys minus sells pulled back out) — never gross churn turnover. This is the
// fix that stops a high-volume scalper (e.g. @greenfia: $831k turnover, $191
// real all-time P&L) from reading as a giant out-profiting insider bet.
test("aggregateMarket: NET realized P&L and NET stake, not gross held-to-resolution", () => {
  const market = { cond: "0xM", tokenId: "t", question: "Q", url: "#", category: "World", eventGroup: "ev", winner: "YES", resolvedMs: 2000000 };
  const T = (w, side, size, price, ts) => ({ proxyWallet: w, side, size, price, outcome: "Yes", timestamp: ts, transactionHash: "0x" + w.slice(2) + ts });
  const trades = [
    // HOLDER: buys 100k @ $0.10 ($10k), never sells, holds YES to resolution.
    T("0xhold", "BUY", 100000, 0.10, 100),
    // CHURNER: buys 100k @ $0.10 ($10k), sells all 100k @ $0.12 ($12k) BEFORE resolution.
    T("0xchurn", "BUY", 100000, 0.10, 100), T("0xchurn", "SELL", 100000, 0.12, 150),
    // PARTIAL: buys 100k @ $0.10 ($10k), sells 40k @ $0.15 ($6k), holds 60k to resolution.
    T("0xpart", "BUY", 100000, 0.10, 120), T("0xpart", "SELL", 40000, 0.15, 160),
  ];
  const out = poly.aggregateMarket(market, trades);

  // HOLDER: 100k winning shares × $1 − $10k cost = +$90k; net invested = full $10k.
  assert.equal(out["0xhold"].pnl, 90000, "holder net P&L = +$90k");
  assert.equal(out["0xhold"].stakeUsd, 10000, "holder net stake = $10k (no sells)");
  assert.equal(out["0xhold"].grossBuyUsd, 10000, "holder gross = $10k");

  // CHURNER: $12k proceeds + $0 held payout − $10k cost = +$2k NET (not the gross +$90k);
  // net invested = max(0, $10k − $12k) = $0, so it cannot trip the outsized-bet signal.
  assert.equal(out["0xchurn"].pnl, 2000, "churner net P&L = +$2k, NOT the gross held-to-resolution +$90k");
  assert.equal(out["0xchurn"].stakeUsd, 0, "churner net stake = $0 (sold more than it sank in)");
  assert.equal(out["0xchurn"].grossBuyUsd, 10000, "churner gross buy still recorded = $10k");
  assert.equal(out["0xchurn"].hz, null, "churner below the $500 net-stake floor → not Harvard-scored");

  // PARTIAL: $6k proceeds + 60k held × $1 − $10k cost = +$56k; net invested = $4k.
  assert.equal(out["0xpart"].pnl, 56000, "partial-seller net P&L = +$56k");
  assert.equal(out["0xpart"].stakeUsd, 4000, "partial net stake = $10k − $6k = $4k");
});

// betPL must consume the NET pnl that aggregateMarket now attaches, so the
// published profit equals the money kept rather than a buy-and-hold fiction.
test("aggregateMarket → betPL: the published P&L is the NET pnl", () => {
  const build = require("./build.js");
  const market = { cond: "0xM2", winner: "YES", url: "#", question: "Q", category: "World", resolvedMs: 2000000 };
  const T = (w, side, size, price, ts) => ({ proxyWallet: w, side, size, price, outcome: "Yes", timestamp: ts, transactionHash: "0x" + ts });
  const out = poly.aggregateMarket(market, [
    T("0xa", "BUY", 50000, 0.20, 100), T("0xa", "SELL", 50000, 0.25, 150),  // +$2.5k net
    T("0xb", "BUY", 50000, 0.20, 100),                                       // holds → +$40k net
    T("0xc", "BUY", 50000, 0.20, 100),
  ]);
  assert.equal(build.betPL(out["0xa"]), 2500, "betPL returns the net +$2.5k (uses pnl, not stake·(1/p−1))");
  assert.equal(build.betPL(out["0xb"]), 40000, "holder betPL = 50k×$1 − $10k = +$40k");
});
