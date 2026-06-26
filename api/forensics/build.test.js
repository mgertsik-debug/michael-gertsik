"use strict";
const test = require("node:test");
const assert = require("node:assert");
const B = require("./build.js");

// helper: a wallet aggregate of `nWin` wins + `nLoss` losses at implied `p`,
// each a distinct underlying event (so they don't de-correlate away).
function agg(address, nWin, nLoss, p, cat, opts) {
  const bets = [];
  let i = 0;
  const stake = (opts && opts.stake) || 800;                // small by default so conviction ($10k) isn't tripped
  for (; i < nWin; i++) bets.push({ cond: "m" + i, eventGroup: "e" + i, question: "Market " + i, url: "#", category: cat, entryPrice: p, stakeUsd: stake, outcome: "YES", won: true, held: true, ts: 1700000000 + i, tx: "0xabc" + i });
  for (let j = 0; j < nLoss; j++, i++) bets.push({ cond: "m" + i, eventGroup: "e" + i, question: "Market " + i, url: "#", category: cat, entryPrice: p, stakeUsd: Math.round(stake / 2), outcome: "YES", won: false, held: true, ts: 1700000000 + i, tx: "0xdef" + i });
  return Object.assign({ address, firstSeenTs: 1699000000, fundingTs: 1698900000, priorTx: 0, bets }, opts || {});
}

test("betPL: uses Polymarket's real pnl when present, estimates only as fallback", () => {
  // real P/L from /positions (e.g. they sold early; pnl != naive payout)
  assert.equal(B.betPL({ won: true, entryPrice: 0.1, stakeUsd: 1000, pnl: 250 }), 250);
  assert.equal(B.betPL({ won: false, entryPrice: 0.1, stakeUsd: 1000, pnl: -1000 }), -1000);
  // no pnl -> estimate held-to-resolution payout
  assert.equal(B.betPL({ won: true, entryPrice: 0.1, stakeUsd: 1000 }), 1000 * (1 / 0.1 - 1));
  assert.equal(B.betPL({ won: false, entryPrice: 0.1, stakeUsd: 1000 }), -1000);
});

test("buildSubject: planted impossible single wallet -> extreme, real 1-in-N, real ledger", () => {
  const s = B.buildSubject(agg("0x4e00000000000000000000000000000000000a91c", 14, 2, 0.11, "Military & Defense"), 0, {});
  assert.ok(s, "subject built");
  B.derive([s]);                                  // apply the artifact-parity derivation
  assert.equal(s.type, "wallet");
  assert.equal(s.tier, "extreme");
  assert.equal(s.marketsCount, 16);
  assert.equal(s.wins, 14);
  assert.ok(s.improbDenom > 1e6, "headline far past 1-in-a-million: " + s.improbDenom);
  assert.ok(/^1 in /.test(s.improbText));
  assert.equal(s.ledger.length, 16);
  assert.ok(s.fired.includes("won"));
  assert.ok(s.scorecard.find((c) => c.key === "won"));
  // derived fields the view reads
  assert.ok(s.percentile > 99);
  assert.ok(s.volumeNum > 0);
});

test("buildSubject: sub-5-bet wallet -> excluded (null), never scored", () => {
  const s = B.buildSubject(agg("0xshort", 3, 1, 0.1, "World"), 0, {});
  assert.equal(s, null);
});

test("buildSubject: random/luck wallet (wins at its implied rate) -> not published", () => {
  const s = B.buildSubject(agg("0xluck", 10, 10, 0.5, "World"), 0, {});
  // ~50% at p=0.5 is exactly expected -> unflagged -> null
  assert.equal(s, null);
});

test("buildSubject: MATERIALITY floor — improbable record on trivial stakes is dropped", () => {
  // a statistically-extreme record (14/16 at 11%) but TINY $20 stakes -> a lucky
  // gambler, not an insider. max event/total stake is far below the $1k floor -> null.
  const tiny = B.buildSubject(agg("0xtiny000000000000000000000000000000000001", 14, 2, 0.11, "Military & Defense", { stake: 20 }), 0, {});
  assert.equal(tiny, null, "sub-$1k-stake record must be filtered out");
  // same record with real money at risk ($1,500/bet) clears the floor and publishes.
  const real = B.buildSubject(agg("0xreal000000000000000000000000000000000002", 14, 2, 0.11, "Military & Defense", { stake: 1500 }), 0, {});
  assert.ok(real && real.tier, "material record publishes");
  // floor is configurable via opts.materialityUsd: set it sky-high -> even big stakes drop.
  const gated = B.buildSubject(agg("0xreal000000000000000000000000000000000002", 14, 2, 0.11, "Military & Defense", { stake: 1500 }), 0, { materialityUsd: 1e9 });
  assert.equal(gated, null);
});

test("buildPayload: ranks by improbability, carries honest meta, derives fields", () => {
  const strong = agg("0xstrong00000000000000000000000000000000a", 14, 2, 0.10, "Elections");
  const weak = agg("0xweak0000000000000000000000000000000000b", 9, 5, 0.18, "Politics");
  const p = B.buildPayload([weak, strong], { reviewed: 41206, screened: 312, snapshot: "Jun 25 2026", recomputed: "Jun 25 2026" });
  assert.ok(p.subjects.length >= 1);
  // most-improbable first
  for (let i = 1; i < p.subjects.length; i++) assert.ok(p.subjects[i - 1].improbDenom >= p.subjects[i].improbDenom);
  assert.equal(p.reviewed, 41206);
  assert.equal(p.meta.snapshot, "Jun 25 2026");
  assert.ok(p.subjects[0].lastActivity);
});

test("RECONSTRUCTED Iran-ring cluster aggregate -> extreme subject with cluster card", () => {
  const bets = [];
  for (let i = 0; i < 30; i++) bets.push({ cond: "m" + i, eventGroup: "e" + i, question: "Q" + i, url: "#", category: "Military & Defense", entryPrice: 0.09, stakeUsd: 20000, outcome: "YES", won: true, held: true, ts: 1700000000 + i, tx: "0x" + i });
  bets.push({ cond: "m30", eventGroup: "e30", question: "Q30", url: "#", category: "Military & Defense", entryPrice: 0.09, stakeUsd: 9000, outcome: "YES", won: false, held: true, ts: 1700000031, tx: "0x30" });
  const edges = Array.from({ length: 12 }, (_, i) => ({ from: "w" + i, to: "w" + (i + 1), link: 0.88, type: "fund", evidence: "shared funder" }));
  const clusterAgg = {
    type: "cluster", id: "c1", address: "0x9a000000000000000000000000000000000000a",
    members: Array.from({ length: 9 }, (_, i) => "0xw" + i), edges,
    firstSeenTs: 1699000000, fundingTs: 1698900000, priorTx: 0,
    conceal: { splitRatio: 0.8, decoyRatio: 0.4, cashoutLatencyHours: 2 },
    bets,
  };
  const s = B.buildSubject(clusterAgg, 0, {});
  assert.ok(s, "cluster subject built");
  assert.equal(s.type, "cluster");
  assert.equal(s.tier, "extreme");
  assert.ok(s.fired.includes("cluster"));
  assert.ok(s.fired.includes("won"));
  assert.ok(s.scorecard.find((c) => c.key === "cluster"));
  assert.ok(s.cluster && s.cluster.size === 9);
});
