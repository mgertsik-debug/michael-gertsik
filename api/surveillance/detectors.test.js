/* Unit tests for the pure surveillance detectors. Run: node --test api/surveillance/
 * Hand-checked values for logit, run-up CAR, VPIN, Kyle's λ / impact, HHI, fusion
 * and classify. Zero deps — Node's built-in test runner only. */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const D = require("./detectors.js");

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b} (±${eps})`);

test("logit: 0.5 -> 0, symmetric, clamped, monotone", () => {
  approx(D.logit(0.5), 0);
  approx(D.logit(0.7310585786), 1, 1e-6);
  approx(D.logit(0.2689414214), -1, 1e-6);
  // clamp: p<=0 treated as 0.001
  approx(D.logit(0), Math.log(0.001 / 0.999), 1e-9);
  assert.ok(D.logit(0.9) > D.logit(0.6));
});

test("logitReturns: exact on a tiny series", () => {
  const r = D.logitReturns([0.5, 0.7310585786, 0.5]);
  approx(r[0], 1, 1e-6);
  approx(r[1], -1, 1e-6);
});

test("mean / stdev / median: exact", () => {
  approx(D.mean([1, 2, 3, 4]), 2.5);
  approx(D.stdev([2, 2, 2]), 0);             // no spread
  approx(D.stdev([1, 3], 2), 1);             // population sd of {1,3} about 2 = 1
  approx(D.median([3, 1, 2]), 2);
  approx(D.median([1, 2, 3, 4]), 2.5);
});

test("normCdf: 0->0.5, symmetric, 1.96->~0.975, monotone", () => {
  approx(D.normCdf(0), 0.5, 1e-9);
  approx(D.normCdf(1.96), 0.975, 2e-3);
  approx(D.normCdf(-1.96), 0.025, 2e-3);
  assert.ok(D.normCdf(3) > 0.99 && D.normCdf(-3) < 0.01);
});

test("runUp: calm estimation then a sustained run-up scores high and up", () => {
  // 12 calm points (tiny alternating wiggle) then a steady climb
  const calm = [0.40, 0.41, 0.40, 0.41, 0.40, 0.41, 0.40];
  const climb = [0.50, 0.62, 0.74, 0.85, 0.93];
  const series = calm.concat(climb).map((p, i) => ({ t: i * 3600, p }));
  const r = D.runUp(series);
  assert.ok(r, "returns a result");
  assert.equal(r.dir, "up");
  assert.ok(r.score > 0.5, `score ${r.score} should be > 0.5`);
  assert.ok(Math.abs(r.carStar) > 0, "carStar nonzero");
});

test("runUp: a flat/noisy series does not score high; short series -> null", () => {
  const noisy = Array.from({ length: 14 }, (_, i) => ({ t: i * 3600, p: 0.50 + (i % 2 ? 0.01 : -0.01) }));
  const r = D.runUp(noisy);
  assert.ok(!r || r.score < 0.5, "noisy flat series stays low");
  assert.equal(D.runUp([{ t: 0, p: 0.5 }, { t: 1, p: 0.5 }]), null);
});

test("vpin: one-sided buying scores high; balanced scores low; short -> null", () => {
  // strictly rising price on rising volume = persistent one-sided pressure
  const oneSided = Array.from({ length: 40 }, (_, i) => ({ ts: i, price: 0.30 + i * 0.012, size: 100 }));
  const vOne = D.vpin(oneSided);
  assert.ok(vOne && vOne.vpin > 0.5, `one-sided vpin ${vOne && vOne.vpin}`);

  // tight oscillation around a level = balanced flow
  const balanced = Array.from({ length: 40 }, (_, i) => ({ ts: i, price: 0.50 + (i % 2 ? 0.005 : -0.005), size: 100 }));
  const vBal = D.vpin(balanced);
  assert.ok(vBal && vBal.vpin < vOne.vpin, "balanced flow is less toxic than one-sided");

  assert.equal(D.vpin([{ ts: 0, price: 0.5, size: 1 }]), null);
});

test("priceImpact: a liquidity vacuum scores higher than calm liquid trading", () => {
  // calm: small moves on big volume
  const calm = Array.from({ length: 10 }, (_, i) => ({ t: i, p: 0.50 + (i % 2 ? 0.005 : -0.005), volume: 100000 }));
  // vacuum: a big move on tiny volume in the last bars
  const vacuum = calm.concat([
    { t: 10, p: 0.65, volume: 800 }, { t: 11, p: 0.80, volume: 600 }, { t: 12, p: 0.88, volume: 500 },
  ]);
  const cImp = D.priceImpact(calm);
  const vImp = D.priceImpact(vacuum);
  assert.ok(cImp && vImp, "both return");
  assert.ok(vImp.score > cImp.score, `vacuum ${vImp.score} > calm ${cImp.score}`);
  assert.equal(D.priceImpact([{ t: 0, p: 0.5, volume: 1 }]), null);
});

test("concentration: HHI exact on a hand case; dominant > diffuse; fresh flag", () => {
  const r = D.concentration([{ wallet: "a", buyUsd: 60 }, { wallet: "b", buyUsd: 30 }, { wallet: "c", buyUsd: 10 }]);
  approx(r.hhi, 0.46, 1e-9);            // .6^2+.3^2+.1^2
  approx(r.top1, 0.6, 1e-9);
  approx(r.score, 0.55 * 0.46 + 0.45 * 0.6, 1e-9);

  const diffuse = D.concentration(Array.from({ length: 10 }, (_, i) => ({ wallet: "w" + i, buyUsd: 100 })));
  approx(diffuse.hhi, 0.1, 1e-9);       // 10 equal wallets => 10*(0.1^2)
  assert.ok(r.score > diffuse.score, "dominant scores higher than diffuse");

  const fresh = D.concentration(
    [{ wallet: "x", buyUsd: 90, firstActiveTs: 1000 }, { wallet: "y", buyUsd: 6, firstActiveTs: 0 }, { wallet: "z", buyUsd: 4, firstActiveTs: 0 }],
    1000 + 3600, // move 1h after wallet x first active
  );
  assert.equal(fresh.fresh, true);
  assert.equal(D.concentration([{ wallet: "a", buyUsd: 1 }]), null);
});

test("newsGap: null -> unexplained E0; pre-event -> E0; credible-after -> explained", () => {
  assert.equal(D.newsGap(null).E, 0);
  assert.equal(D.newsGap(null).explained, false);
  const pre = D.newsGap({ credibility: "official", hoursFromMove: 2, preEvent: true });
  assert.equal(pre.E, 0);
  assert.equal(pre.preEvent, true);
  const after = D.newsGap({ credibility: "official", hoursFromMove: 1, preEvent: false, directionMatch: true });
  assert.ok(after.E >= 0.5 && after.explained, `E ${after.E}`);
  const weak = D.newsGap({ credibility: "social", hoursFromMove: 40, preEvent: false });
  assert.ok(weak.E < 0.5, "weak distant social signal is not explanatory");
});

test("liquidityQ: thin book -> low Q (artifact), deep book -> high Q", () => {
  const thin = D.liquidityQ({ volumeUsd: 200, spread: 0.08, depthUsd: 100, tradeCount: 3 });
  assert.ok(thin.Q <= D.DEFAULTS.tauQ, `thin Q ${thin.Q} <= ${D.DEFAULTS.tauQ}`);
  const deep = D.liquidityQ({ volumeUsd: 2_000_000, spread: 0.005, depthUsd: 200000, tradeCount: 2000 });
  assert.ok(deep.Q > 0.7, `deep Q ${deep.Q}`);
});

const W = { runUp: 0.30, vpin: 0.25, priceImpact: 0.20, concentration: 0.25 };
const dets = (subs) => ["runUp", "vpin", "priceImpact", "concentration"].map((k) => ({ key: k, weight: W[k], sub: subs[k] != null ? subs[k] : null }));

test("fuse: renormalises over the checks that RAN, reports coverage, gates the tier", () => {
  // all four ran and agree -> full coverage, High-signal
  const all = D.fuse(dets({ runUp: 1, vpin: 1, priceImpact: 1, concentration: 1 }), { E: 0, Q: 1 });
  assert.equal(all.score, 100);
  assert.equal(all.coverageRan, 4); assert.equal(all.coverageTotal, 4);
  assert.equal(all.fullCoverage, true); assert.equal(all.agreeing, 4);
  assert.equal(all.tier, "High-signal");

  // ONLY one check ran: renormalised so the score reflects it, but coverage is
  // 1/4 and it can never be High-signal — this is the "everything is 30" fix.
  const one = D.fuse(dets({ runUp: 1 }), { E: 0, Q: 1 });
  assert.equal(one.score, 100);                 // renormalised over the one that ran
  assert.equal(one.coverageRan, 1); assert.equal(one.coverageTotal, 4);
  assert.equal(one.fullCoverage, false);
  assert.notEqual(one.tier, "High-signal");     // gated: <2 agreeing, partial coverage
  assert.equal(one.tier, "Elevated");

  // three agree but coverage incomplete -> Elevated, not High-signal
  const three = D.fuse(dets({ runUp: 0.9, vpin: 0.9, priceImpact: 0.9 }), { E: 0, Q: 1 });
  assert.equal(three.fullCoverage, false);
  assert.equal(three.tier, "Elevated");

  // news discount + points sum to the score
  assert.equal(D.fuse(dets({ runUp: 1, vpin: 1, priceImpact: 1, concentration: 1 }), { E: 0.5, Q: 1 }).score, 70);
  const mid = D.fuse(dets({ runUp: 0.8, vpin: 0.6, priceImpact: 0.4, concentration: 0.2 }), { E: 0, Q: 1 });
  assert.equal(mid.contributions.reduce((s, c) => s + c.points, 0), mid.score);

  // category multiplier raises a high-conflict market
  const plain = D.fuse(dets({ runUp: 0.6, vpin: 0.6, priceImpact: 0.6, concentration: 0.6 }), { E: 0, Q: 1 });
  const mult = D.fuse(dets({ runUp: 0.6, vpin: 0.6, priceImpact: 0.6, concentration: 0.6 }), { E: 0, Q: 1, categoryMult: 1.25 });
  assert.ok(mult.score > plain.score);

  assert.equal(D.fuse([], {}).tier, "Insufficient data");
});

test("tierOf: thin book caps at Watch; High needs full coverage + >=2 agreeing", () => {
  assert.equal(D.tierOf({ score: 95, agreeing: 3, fullCoverage: true, Q: 0.1 }), "Watch");   // thin
  assert.equal(D.tierOf({ score: 80, agreeing: 2, fullCoverage: true, Q: 0.9 }), "High-signal");
  assert.equal(D.tierOf({ score: 80, agreeing: 1, fullCoverage: true, Q: 0.9 }), "Elevated"); // only 1 agrees
  assert.equal(D.tierOf({ score: 80, agreeing: 3, fullCoverage: false, Q: 0.9 }), "Elevated"); // partial coverage
  assert.equal(D.tierOf({ score: 35, agreeing: 1, fullCoverage: true, Q: 0.9 }), "Watch");
  assert.equal(D.tierOf({ score: 10, agreeing: 0, fullCoverage: true, Q: 0.9 }), "Clear");
});

test("longshot: large bet at low implied that WON scores high; otherwise low/0", () => {
  const small = D.longshot({ stakeUsd: 100, impliedProb: 0.2, won: true, category: "world" });
  assert.equal(small.isLongshot, false);
  assert.equal(small.score, 0);
  const win = D.longshot({ stakeUsd: 5000, impliedProb: 0.05, won: true, category: "world" });
  assert.ok(win.isLongshot && win.score > 0.7);
  const lose = D.longshot({ stakeUsd: 5000, impliedProb: 0.05, won: false, category: "world" });
  assert.ok(lose.score < 0.2);
  assert.equal(D.longshot({ stakeUsd: null }), null);
});

test("classify: each branch in priority order", () => {
  assert.equal(D.classify({ Q: 0.1, raw: 0.9, E: 0.9 }), "Low-liquidity artifact"); // Q wins
  assert.equal(D.classify({ Q: 0.9, raw: 0.2, E: 0.8, preEvent: false }), "Explained");
  assert.equal(D.classify({ Q: 0.9, raw: 0.8, E: 0.1, preEvent: true }), "Unexplained");
  assert.equal(D.classify({ Q: 0.9, raw: 0.3, E: 0.1, preEvent: false }), "Partially explained");
});

/* ===== Part 8 — mandatory validation tests (engine before live data) ===== */
const DETW = { runUp: 0.30, vpin: 0.25, priceImpact: 0.20, concentration: 0.25 };
const idets = (subs) => ["runUp", "vpin", "priceImpact", "concentration"].map((k) => ({ key: k, weight: DETW[k], sub: subs[k] != null ? subs[k] : null }));

test("Part8.1 planted insider series -> run-up fires hard, mostly pre-catalyst", () => {
  // flat, then a large one-sided pre-catalyst move
  const flat = Array.from({ length: 18 }, (_, i) => ({ t: i * 3600, p: 0.30 + (i % 2 ? 0.008 : -0.008) }));
  const surge = [0.34, 0.45, 0.6, 0.75, 0.88, 0.93].map((p, i) => ({ t: (18 + i) * 3600, p }));
  const r = D.runUp(flat.concat(surge));
  assert.ok(r && r.score > 0.6, `run-up score ${r && r.score}`);
  assert.ok(r.preMoveFraction >= 0.5, `pre-move fraction ${r.preMoveFraction}`);
  // with news-gap pre-event and full coverage + agreement -> High-signal
  const f = D.fuse(idets({ runUp: r.score, vpin: 0.7, priceImpact: 0.6, concentration: 0.7 }), { E: 0, Q: 0.8, preEvent: true });
  assert.equal(f.tier, "High-signal");
});

test("Part8.2 random walk -> low run-up, not flagged", () => {
  let p = 0.5; const rw = [];
  const seed = (n) => { let s = n; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };
  const rnd = seed(7);
  for (let i = 0; i < 40; i++) { p = Math.max(0.05, Math.min(0.95, p + (rnd() - 0.5) * 0.02)); rw.push({ t: i * 3600, p }); }
  const r = D.runUp(rw);
  assert.ok(!r || r.score < 0.5, `random walk run-up ${r && r.score}`);
});

test("Part8.3 post-news mover -> labeled Explained, score pulled down", () => {
  const f = D.fuse(idets({ runUp: 0.9, vpin: 0.8, priceImpact: 0.7, concentration: 0.8 }), { E: 0.8, Q: 0.8, preEvent: false });
  assert.equal(f.label, "Explained");
  assert.ok(f.score < 60, `explained score ${f.score}`);
  assert.notEqual(f.tier, "High-signal");
});

test("Part8.4 thin-market jitter -> Low-liquidity artifact / capped at Watch", () => {
  const q = D.liquidityQ({ volumeUsd: 300, depthUsd: 150, spread: 0.08, tradeCount: 4 });
  assert.ok(q.Q <= D.DEFAULTS.tauQ);
  const f = D.fuse(idets({ runUp: 0.9, vpin: 0.9, priceImpact: 0.9, concentration: 0.9 }), { E: 0, Q: q.Q });
  assert.equal(f.tier, "Watch");                 // thin book can't be High-signal
  assert.equal(f.label, "Low-liquidity artifact");
});

test("Part8.5 missing-data market -> excluded not 0; can't reach High on one check", () => {
  const f = D.fuse(idets({ runUp: 0.95 }), { E: 0, Q: 0.8 });   // 3 of 4 have no data
  assert.equal(f.coverageRan, 1); assert.equal(f.coverageTotal, 4);
  assert.notEqual(f.tier, "High-signal");
  // the missing checks did NOT contribute a 0 that dragged the score down:
  assert.equal(f.contributions.length, 1);
});

test("Part8.6 reconstructed real cases fire the right detectors", () => {
  // Spagnuolo / Bubblemaps: winning at very low implied -> longshot ceiling
  const spag = D.longshot({ stakeUsd: 200000, impliedProb: 0.0, won: true, category: "world" });
  assert.ok(spag.isLongshot && spag.score > 0.85);
  // Van Dyke: pre-raid accumulation, held to resolution, won
  const vd = D.accumulation({ netPreUsd: 33000, soldFracPre: 0.0, won: true });
  assert.ok(vd.score > 0.7 && vd.held === true);
  // Bubblemaps linked cluster: high HHI + top share -> concentration ceiling
  const bm = D.concentration([{ wallet: "a", buyUsd: 900 }, { wallet: "b", buyUsd: 60 }, { wallet: "c", buyUsd: 40 }]);
  assert.ok(bm.score > 0.6);
  // Santos (Kalshi, no wallet ledger): flags on run-up alone WITHOUT concentration
  const santos = D.fuse([
    { key: "runUp", weight: 0.30, sub: 0.85 }, { key: "vpin", weight: 0.25, sub: 0.6 },
    { key: "priceImpact", weight: 0.20, sub: 0.55 }, { key: "concentration", weight: 0.25, sub: null },
  ], { E: 0, Q: 0.7 });
  assert.ok(santos.score > 0 && santos.coverageRan === 3, "Kalshi flags without wallet data");
  // Kalshi small-dollar self-trade: category/role multiplier keeps it from being buried
  const plain = D.fuse(idets({ runUp: 0.5, vpin: 0.4 }), { E: 0, Q: 0.7 });
  const conflict = D.fuse(idets({ runUp: 0.5, vpin: 0.4 }), { E: 0, Q: 0.7, categoryMult: 1.25 });
  assert.ok(conflict.score > plain.score);
});

test("Part8 manipulation detectors: wash + ramp", () => {
  const wash = D.washTrade({ selfMatchedUsd: 80000, totalUsd: 100000, linkedPairs: 3 });
  assert.ok(wash.score > 0.6 && wash.selfFrac === 0.8);
  assert.equal(D.washTrade({ totalUsd: 0 }), null);
  const ramp = D.ramp({ closeVolFrac: 0.6, moveIntoClose: 0.8, volVsBaseline: 4 });
  assert.ok(ramp.score > 0.6);
  assert.equal(D.STREAMING_ONLY.available, false);   // spoofing is an honest boundary
});

test("Part8 accumulation/volumeRunup guards + behavior", () => {
  assert.equal(D.accumulation({}), null);
  const v = D.volumeRunup({ preVol: 50000, baseVol: 5000 });
  assert.ok(v.score > 0.5 && v.ratio === 10);
  assert.equal(D.volumeRunup({ preVol: 1, baseVol: 0 }), null);
});
