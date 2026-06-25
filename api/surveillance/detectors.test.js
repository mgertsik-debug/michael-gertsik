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

test("fuse: renormalises weights, omits concentration for Kalshi, applies news discount", () => {
  const all = { runUp: 1, vpin: 1, priceImpact: 1, concentration: 1 };
  const poly = D.fuse(all, { platform: "polymarket", E: 0, Q: 1 });
  assert.equal(poly.index, 100);
  assert.equal(poly.label, "Unexplained");

  // E=0.5, gamma 0.6 -> 100*(1-0.3) = 70
  const discounted = D.fuse(all, { platform: "polymarket", E: 0.5, Q: 1 });
  assert.equal(discounted.index, 70);

  // kalshi omits concentration: only 3 detectors, weights renormalised over 0.75
  const k = D.fuse({ runUp: 1, vpin: 0, priceImpact: 0 }, { platform: "kalshi", E: 0, Q: 1 });
  approx(k.contributions.find((c) => c.key === "runUp").weight, 0.40, 1e-9);
  assert.equal(k.contributions.some((c) => c.key === "concentration"), false);
  assert.equal(k.index, 40);   // 0.40 * 1.0

  assert.equal(D.fuse({}, { platform: "kalshi" }).label, "Insufficient data");
});

test("classify: each branch in priority order", () => {
  assert.equal(D.classify({ Q: 0.1, raw: 0.9, E: 0.9 }), "Low-liquidity artifact"); // Q wins
  assert.equal(D.classify({ Q: 0.9, raw: 0.2, E: 0.8, preEvent: false }), "Explained");
  assert.equal(D.classify({ Q: 0.9, raw: 0.8, E: 0.1, preEvent: true }), "Unexplained");
  assert.equal(D.classify({ Q: 0.9, raw: 0.3, E: 0.1, preEvent: false }), "Partially explained");
});
