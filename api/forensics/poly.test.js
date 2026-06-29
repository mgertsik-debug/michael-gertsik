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
