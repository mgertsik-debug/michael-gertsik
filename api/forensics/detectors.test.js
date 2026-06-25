"use strict";
const test = require("node:test");
const assert = require("node:assert");
const D = require("./detectors.js");

const bets = (specs) => specs.flatMap(([n, p, won, group]) =>
  Array.from({ length: n }, () => ({ impliedProb: p, won, eventGroup: group })));

test("binomTailGE: hand-checked exact values", () => {
  assert.ok(Math.abs(D.binomTailGE(2, 2, 0.5) - 0.25) < 1e-9);          // (0.5)^2
  assert.ok(Math.abs(D.binomTailGE(1, 1, 0.3) - 0.3) < 1e-9);
  assert.ok(Math.abs(D.binomTailGE(10, 10, 0.5) - 1 / 1024) < 1e-9);    // 0.5^10
  assert.equal(D.binomTailGE(5, 0, 0.2), 1);                            // P(X>=0)=1
  assert.equal(D.binomTailGE(5, 6, 0.2), 0);                            // k>n
  // C(4,2)=6: P(X=2)+... ; P(X>=2|4,0.5) = 11/16
  assert.ok(Math.abs(D.binomTailGE(4, 2, 0.5) - 11 / 16) < 1e-9);
});

test("logChoose: C(16,14)=120, C(9,2)=36", () => {
  assert.ok(Math.abs(Math.exp(D.logChoose(16, 14)) - 120) < 1e-6);
  assert.ok(Math.abs(Math.exp(D.logChoose(9, 2)) - 36) < 1e-6);
});

test("improbText formats K/M/B", () => {
  assert.equal(D.improbText(4200000), "1 in 4.2M");
  assert.equal(D.improbText(9400), "1 in 9.4K");
  assert.equal(D.improbText(120000), "1 in 120K");
  assert.equal(D.improbText(1800000000), "1 in 1.8B");
});

test("won: planted impossible record -> Extreme, sane 1-in-N", () => {
  // 14 wins + 2 losses at ~11% implied, all independent
  const r = D.won(bets([[14, 0.11, true], [2, 0.11, false]]));
  assert.equal(r.hasData, true);
  assert.equal(r.n, 16); assert.equal(r.k, 14);
  assert.ok(r.P <= D.DEFAULTS.pExtreme, "P should clear the Extreme threshold: " + r.P);
  assert.ok(r.improbDenom > 1e6, "denom far past 1-in-a-million: " + r.improbDenom);
  assert.ok(r.score > 0.9);
  assert.equal(r.expectedWins, +(16 * 0.11).toFixed(2));
});

test("won: random/luck wallet (wins at its implied rate) -> not extreme", () => {
  // n=20 at p=0.5, 10 wins (exactly expected)
  const r = D.won(bets([[10, 0.5, true], [10, 0.5, false]]));
  assert.equal(r.hasData, true);
  assert.ok(r.P > D.DEFAULTS.pHigh, "luck wallet must not clear High: " + r.P);
  assert.ok(r.score < 0.5);
});

test("won: < 5 independent bets -> hasData=false (excluded, not zeroed)", () => {
  const r = D.won(bets([[4, 0.1, true]]));
  assert.equal(r.hasData, false);
  assert.equal(r.score, undefined);
});

test("won: correlated bets are DE-CORRELATED, not inflated", () => {
  // 6 independent events all won at p=0.1
  const indep = D.won(bets([[1, 0.1, true, "e1"], [1, 0.1, true, "e2"], [1, 0.1, true, "e3"],
    [1, 0.1, true, "e4"], [1, 0.1, true, "e5"], [1, 0.1, true, "e6"]]));
  // same 6 events but each repeated 5x (30 correlated bets) — must collapse to n=6
  const corr = D.won(bets([[5, 0.1, true, "e1"], [5, 0.1, true, "e2"], [5, 0.1, true, "e3"],
    [5, 0.1, true, "e4"], [5, 0.1, true, "e5"], [5, 0.1, true, "e6"]]));
  assert.equal(corr.n, 6, "30 correlated bets collapse to 6 effective");
  assert.equal(corr.collapsed, 24);
  // de-correlated P must equal the 6-independent case (not the absurd 30-bet number)
  assert.ok(Math.abs(corr.P - indep.P) < 1e-12);
  // a naive 30-of-30 would be ~p^30 — astronomically smaller; confirm we didn't do that
  const naive = D.binomTailGE(30, 30, 0.1);
  assert.ok(corr.P > naive * 1e6, "de-correlated tail must be vastly larger than the naive 30-bet tail");
});

test("longshot / held / fresh fire on the right thresholds", () => {
  assert.equal(D.longshot([0.08, 0.12, 0.11]).fires, true);   // mean 0.10 <= 0.20
  assert.equal(D.longshot([0.3, 0.4, 0.5]).fires, false);
  assert.equal(D.longshot([]).hasData, false);
  assert.equal(D.held({ heldToResolution: 16, total: 16 }).fires, true);
  assert.equal(D.held({ heldToResolution: 5, total: 16 }).fires, false);
  assert.equal(D.fresh({ ageDays: 4, priorTx: 0 }).fires, true);
  assert.equal(D.fresh({ ageDays: 4, priorTx: 3 }).fires, false);  // had prior tx
  assert.equal(D.fresh({ ageDays: 200, priorTx: 0 }).fires, false);
});

test("baseline: win-rate vs category baseline", () => {
  const b = D.baseline({ winRate: 94, category: "Military & Defense" });
  assert.equal(b.baseline, 52);
  assert.ok(b.score > 0);
  assert.equal(D.baseline({ winRate: 0.14, category: "x" }).baseline, 14);
});

test("clusterLink: hand-checked weighted sum; clusterScore threshold", () => {
  assert.equal(D.clusterLink({ sharedFunder: 1, coSpend: 1, syncEntry: 1, createProx: 1 }), 1);
  assert.equal(D.clusterLink({ sharedFunder: 1 }), 0.4);   // w1 only
  assert.ok(Math.abs(D.clusterLink({ sharedFunder: 0.8, coSpend: 0.8, syncEntry: 0.8, createProx: 0.8 }) - 0.8) < 1e-9);
  const cs = D.clusterScore([{ link: 0.9 }, { link: 0.86 }, { link: 0.88 }], 9);
  assert.equal(cs.isCluster, true);
  assert.equal(D.clusterScore([{ link: 0.5 }, { link: 0.6 }], 4).isCluster, false);
});

test("concealment: fires only with >= 2 co-occurring tactics", () => {
  assert.equal(D.concealment({ splitRatio: 0.7, decoyRatio: 0.4, cashoutLatencyHours: 3 }).fires, true);
  assert.equal(D.concealment({ splitRatio: 0.7 }).fires, false);             // one tactic only
  assert.equal(D.concealment({}).hasData, false);
});

test("fuse: contribution weights renormalise over FIRED detectors only", () => {
  const dets = {
    won: { hasData: true, score: 1, P: 1e-7, improbDenom: 4200000, improbText: "1 in 4.2M" },
    longshot: { hasData: true, score: 0.8, fires: true },
    held: { hasData: true, score: 0.9, fires: true },
    fresh: { hasData: true, score: 0.2, fires: false },   // ran but didn't fire -> excluded
  };
  const f = D.fuse(dets);
  // fired = won(34) + longshot(12) + held(6) = 52
  assert.deepEqual(f.fired.sort(), ["held", "longshot", "won"]);
  assert.equal(f.contributions.won, Math.round(34 / 52 * 100));   // 65
  assert.equal(f.contributions.longshot, Math.round(12 / 52 * 100)); // 23
  assert.equal(f.contributions.held, Math.round(6 / 52 * 100));    // 12
  assert.ok(!("fresh" in f.contributions));
  assert.equal(f.tier, "extreme");   // P<=1e-6 and >=2 agreeing
});

test("fuse: skilled-but-legit (one detector, modest edge) is NOT Extreme/High", () => {
  // big-n favorite bettor who beats the odds a bit: won fires weakly, longshot doesn't
  const w = D.won(bets([[26, 0.45, true], [14, 0.45, false]]));  // 26/40 at 0.45
  const ls = D.longshot(Array(40).fill(0.45));
  const f = D.fuse({ won: w, longshot: ls });
  assert.notEqual(f.tier, "extreme");
  assert.notEqual(f.tier, "high");   // <2 agreeing detectors -> capped at notable
});

test("conviction: a lone large deep-longshot win fires; small/shallow bets don't", () => {
  // Van Dyke shape: one $32k bet at ~8% that won, held
  const vd = D.conviction([{ impliedProb: 0.08, won: true, held: true, stakeUsd: 32000, question: "Maduro captured?" }]);
  assert.equal(vd.hasData, true);
  assert.equal(vd.fires, true);
  assert.ok(vd.payout > 300000, "≈$400k payout: " + vd.payout);
  // too small
  assert.ok(!D.conviction([{ impliedProb: 0.08, won: true, held: true, stakeUsd: 500 }]).fires);
  // not deep enough (favorite-ish)
  assert.ok(!D.conviction([{ impliedProb: 0.40, won: true, held: true, stakeUsd: 50000 }]).fires);
  // a loss never counts
  assert.equal(D.conviction([{ impliedProb: 0.08, won: false, held: true, stakeUsd: 32000 }]).hasData, false);
});

test("SINGLE-BET INSIDER (Van Dyke): 1 bet -> binomial can't score, conviction path -> High (not Extreme)", () => {
  const bets = [{ impliedProb: 0.08, won: true, held: true, stakeUsd: 32000 }];
  const wonD = D.won(bets);                              // 1 bet < 5 -> excluded
  assert.equal(wonD.hasData, false);
  const conv = D.conviction(bets);
  const ls = D.longshot([0.08]);
  const hd = D.held({ heldToResolution: 1, total: 1 });
  const f = D.fuse({ won: wonD, conviction: conv, longshot: ls, held: hd });
  assert.equal(f.tier, "high", "single high-conviction insider bet should reach High via the confluence path");
  assert.notEqual(f.tier, "extreme");                   // one bet can't be statistically extreme
  assert.ok(f.fired.includes("conviction"));
  assert.equal(f.convictionPath, true);
});

test("RECONSTRUCTED Iran-ring cluster (9 wallets, ~98% win, fresh, held) -> Extreme", () => {
  const ring = D.won(bets([[30, 0.09, true], [1, 0.09, false]]));   // 30/31 at 9%
  const cluster = D.clusterScore(Array.from({ length: 10 }, () => ({ link: 0.88 })), 9);
  const ls = D.longshot(Array(31).fill(0.09));
  const hd = D.held({ heldToResolution: 31, total: 31 });
  const cc = D.concealment({ splitRatio: 0.8, cashoutLatencyHours: 2, decoyRatio: 0.4 });
  const f = D.fuse({ won: ring, cluster, longshot: ls, held: hd, conceal: cc });
  assert.equal(ring.P <= D.DEFAULTS.pExtreme, true);
  assert.equal(cluster.isCluster, true);
  assert.equal(f.tier, "extreme");
  assert.ok(f.agreeing >= 2);
  assert.ok(f.fired.includes("cluster") && f.fired.includes("won"));
});
