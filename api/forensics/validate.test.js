"use strict";
const test = require("node:test");
const assert = require("node:assert");
const V = require("./validate.js");

// A flagged set that WINS far more than the market priced → must be many SD above chance.
function winners(nWallets, betsPer, p, winFrac) {
  const subs = [];
  for (let w = 0; w < nWallets; w++) {
    const ledger = [];
    for (let b = 0; b < betsPer; b++) ledger.push({ odds: Math.round(p * 100), outcome: (b / betsPer) < winFrac ? "Won" : "Lost" });
    const wins = ledger.filter((r) => r.outcome === "Won").length;
    subs.push({ winRate: Math.round(100 * wins / betsPer), fired: w % 2 ? ["won", "fresh"] : ["won"], ledger });
  }
  return subs;
}

test("permutation test: a set that beats its market odds reads many SD above chance", () => {
  const subs = winners(10, 10, 0.20, 0.70);           // bought 20% long-shots, won 70%
  const r = V.permutationTest(subs, { iters: 5000, seed: 1 });
  assert.ok(r.hasData, "has data");
  assert.equal(r.nBets, 100);
  assert.ok(r.zScore > 5, "should be well above chance, got z=" + r.zScore);
  assert.ok(r.pEmpirical === 0 || r.pEmpirical < 0.001, "tiny empirical p");
  assert.ok(/standard deviations above chance/.test(r.statement), "human statement present");
});

test("permutation test: a set that wins AT its market odds reads ~0 SD (honest null)", () => {
  // 50%-priced bets that win ~50% → no edge → z near 0, p not significant.
  const subs = winners(20, 20, 0.50, 0.50);
  const r = V.permutationTest(subs, { iters: 5000, seed: 7 });
  assert.ok(r.hasData);
  assert.ok(Math.abs(r.zScore) < 3, "no real edge → small |z|, got " + r.zScore);
});

test("permutation test: too few bets → honest no-data, never a fabricated z", () => {
  const r = V.permutationTest([{ winRate: 100, fired: ["won"], ledger: [{ odds: 10, outcome: "Won" }] }], { iters: 100 });
  assert.equal(r.hasData, false);
  assert.ok(/too few/.test(r.note));
});

test("per-detector validation: reports win-rate lift with sample sizes + reliability flag", () => {
  const subs = winners(20, 10, 0.25, 0.65);
  const rows = V.perDetectorValidation(subs);
  const won = rows.find((x) => x.key === "won");
  assert.ok(won, "won detector present");
  assert.equal(won.firedN, 20, "all fired 'won'");
  // 'fresh' fired on half → both partitions populated
  const fresh = rows.find((x) => x.key === "fresh");
  assert.ok(fresh && fresh.firedN === 10 && fresh.notFiredN === 10);
  assert.ok(typeof fresh.reliable === "boolean");
});

test("determinism: same seed → identical empirical p (reproducible)", () => {
  const subs = winners(8, 8, 0.30, 0.60);
  const a = V.permutationTest(subs, { iters: 3000, seed: 42 });
  const b = V.permutationTest(subs, { iters: 3000, seed: 42 });
  assert.equal(a.pEmpirical, b.pEmpirical);
  assert.equal(a.zScore, b.zScore);
});
