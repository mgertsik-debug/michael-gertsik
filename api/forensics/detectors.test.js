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
  // fired = won(32) + longshot(11) + held(6) = 49  (weights from DEFAULTS.contribW)
  const W = D.DEFAULTS.contribW, tot = W.won + W.longshot + W.held;
  assert.deepEqual(f.fired.sort(), ["held", "longshot", "won"]);
  assert.equal(f.contributions.won, Math.round(W.won / tot * 100));
  assert.equal(f.contributions.longshot, Math.round(W.longshot / tot * 100));
  assert.equal(f.contributions.held, Math.round(W.held / tot * 100));
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

test("concentration: all-YES, one-cluster, >$10k fires; hedged or small does not; <3 bets excluded", () => {
  const all = [
    { stakeUsd: 9000, outcome: "YES", eventGroup: "maduro" },
    { stakeUsd: 8000, outcome: "YES", eventGroup: "maduro" },
    { stakeUsd: 7000, outcome: "YES", eventGroup: "maduro" },
  ];
  const c = D.concentration(all);
  assert.equal(c.hasData, true);
  assert.equal(c.fires, true, "100% YES, one cluster, $24k -> fires");
  assert.ok(c.dirPurity >= 0.95 && c.clusterDensity >= 0.95);
  // hedged: half YES half NO -> purity 0.5, doesn't fire
  assert.equal(D.concentration([{ stakeUsd: 9000, outcome: "YES", eventGroup: "a" }, { stakeUsd: 9000, outcome: "NO", eventGroup: "b" }, { stakeUsd: 9000, outcome: "YES", eventGroup: "c" }]).fires, false);
  // below the $10k money floor -> doesn't fire even at 100% one-way
  assert.equal(D.concentration([{ stakeUsd: 100, outcome: "YES" }, { stakeUsd: 100, outcome: "YES" }, { stakeUsd: 100, outcome: "YES" }]).fires, false);
  // ANTI-COLLUSION: a single bet can't satisfy concentration (needs >= 3)
  assert.equal(D.concentration([{ stakeUsd: 32000, outcome: "YES" }]).hasData, false);
});

test("sizing: a bet that dwarfs the wallet's own median fires; uniform sizing does not; <4 bets excluded", () => {
  // normally bets ~$100, then one $40k event -> ~400x median
  const hist = [{ stakeUsd: 100 }, { stakeUsd: 120 }, { stakeUsd: 80 }, { stakeUsd: 110 }, { stakeUsd: 40000, eventGroup: "tip" }];
  const s = D.sizing(hist);
  assert.equal(s.hasData, true);
  assert.equal(s.fires, true);
  assert.ok(s.ratio >= 8 && s.maxEventStake >= 3000);
  // uniform sizing -> ratio ~1, doesn't fire
  assert.equal(D.sizing([{ stakeUsd: 500 }, { stakeUsd: 520 }, { stakeUsd: 480 }, { stakeUsd: 510 }]).fires, false);
  // big jump but below the absolute floor -> doesn't fire ($40 is 8x $5 but tiny)
  assert.equal(D.sizing([{ stakeUsd: 5 }, { stakeUsd: 5 }, { stakeUsd: 5 }, { stakeUsd: 40 }]).fires, false);
  // ANTI-COLLUSION: too few bets to define a distribution -> hasData=false
  assert.equal(D.sizing([{ stakeUsd: 32000 }, { stakeUsd: 100 }]).hasData, false);
});

test("anti-collusion: a LONE conviction bet can't reach High on size-only signals", () => {
  // single $32k @ 8% win — conviction fires, but sizing/concentration are inert (1 bet)
  const lone = [{ impliedProb: 0.08, entryPrice: 0.08, won: true, held: true, stakeUsd: 32000, outcome: "YES" }];
  const conv = D.conviction(lone);
  const conc = D.concentration(lone);   // <3 bets
  const siz = D.sizing(lone);           // <4 bets
  assert.equal(conv.fires, true);
  assert.equal(conc.hasData, false);
  assert.equal(siz.hasData, false);
  // conviction alone (only 1 agreeing) must NOT reach High — the gate still needs
  // 2 INDEPENDENT detectors that aren't all driven by the same big bet.
  const f = D.fuse({ won: D.won(lone), conviction: conv, concentration: conc, sizing: siz });
  assert.notEqual(f.tier, "high");
  assert.notEqual(f.tier, "extreme");
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

test("HARVARD composite: faithful 5-signal score + profitability gate + tiers", () => {
  // Paper's LOCKED weights: S = 30·zpc + 25·zbc + 20·zbw + 15·late + 10·dir, late/dir on [0,1].
  const e = D.harvardEpisode({ zBetCross: 12, zBetWithin: 5, zProfitCross: 18, lateBuyFraction: 0.5, directionalScore: 1.0, won: true });
  // 30*18 + 25*12 + 20*5 + 15*0.5 + 10*1.0 = 540 + 300 + 100 + 7.5 + 10 = 957.5
  assert.equal(e.S, 957.5, "all 5 signals at the paper's weights; late/dir on [0,1]");
  assert.equal(e.retained, true, "retained: outsized bet AND won AND out-profited peers");
  assert.equal(e.profitable, true);
  assert.equal(D.harvardTier(e.S), "high", "S=957.5 -> high (in [810,1110))");

  // SCALE LOCK — late/dir must enter on [0,1], so a fully-late, fully-directional episode adds
  // EXACTLY 15+10 = 25 points, not 1500+1000. Regression guard against the old ·100 units bug.
  const base = D.harvardEpisode({ zBetCross: 3, zBetWithin: 0, zProfitCross: 0, lateBuyFraction: 0, directionalScore: 0, won: true });
  const maxed = D.harvardEpisode({ zBetCross: 3, zBetWithin: 0, zProfitCross: 0, lateBuyFraction: 1, directionalScore: 1, won: true });
  assert.equal(maxed.S - base.S, 25, "late=1 + dir=1 adds 25 (15+10), NOT 2500 — no ·100");

  // PROFITABILITY GATE: a big LOSING bet (or one that under-profited peers) is NOT retained,
  // however large/late/one-sided — this is the fix for losers scoring high.
  const loser = D.harvardEpisode({ zBetCross: 12, zBetWithin: 5, zProfitCross: -4, lateBuyFraction: 1, directionalScore: 1, won: false });
  assert.equal(loser.retained, false, "lost the bet -> not retained even with huge bet-size z");
  const underProfit = D.harvardEpisode({ zBetCross: 12, zBetWithin: 5, zProfitCross: -1, lateBuyFraction: 1, directionalScore: 1, won: true });
  assert.equal(underProfit.retained, false, "won but under-profited peers (zProfit<0) -> not retained");

  // retention also requires z_bet_cross>2 OR z_bet_within>2 (outsized bet), even for winners
  const small = D.harvardEpisode({ zBetCross: 1.2, zBetWithin: 0.9, zProfitCross: 5, won: true });
  assert.equal(small.retained, false, "not retained when neither bet-size z exceeds 2");

  // tier thresholds (calibrated to our gated, profit-weighted distribution: 530/810/1110)
  assert.equal(D.harvardTier(400), null, "below notable floor -> unflagged");
  assert.equal(D.harvardTier(600), "notable");
  assert.equal(D.harvardTier(900), "high");
  assert.equal(D.harvardTier(1200), "extreme");

  // missing cross-sectional z degrades to NO-DATA — never a fabricated S=0 (honesty rule).
  const z = D.harvardEpisode({});
  assert.equal(z.hasData, false, "no measurable z_bet_cross -> hasData:false, not a fake S=0");
  const partial = D.harvardEpisode({ zBetCross: 3, won: true });
  assert.equal(partial.hasData, true); assert.equal(partial.S, 75, "25*3 with the other four signals at 0");
});

/* ============================================================================
 *  FAVORITE / CROSS-SECTIONAL PUBLISH PATH (option B: folded into the ONE wallet store).
 *  The favorite-odds informed trader the ≤35% long-shot binomial is blind to — gated HARD so it
 *  cannot reproduce the documented mass false positives (net-losing whales, bare whales on faves).
 * ========================================================================== */
const B = require("./build.js");
function favAgg(over) {
  const fund = 1699000000, first = fund + 5 * 86400;          // 5-day-old wallet (fresh fires when priorTx=0)
  const base = {
    address: "0xFAVdeadbeef0000000000000000000000000001",
    firstSeenTs: first, fundingTs: fund, priorTx: 0,           // (fresh fires, but it no longer gates — proxy-wallet noise)
    conceal: { splitRatio: 0.6, cashoutLatencyHours: 2 },      // 2 concealment tactics = the real STRUCTURAL corroborator
    profile: { username: "fave-insider", pnlAllTime: 26000, volume: 60000 },
    bets: [
      // the flagged episode: a big WINNING bet on a FAVORITE (65%), outsized + out-profited peers
      { cond: "0xfav", question: "Will X win?", url: null, category: "Politics", entryPrice: 0.65,
        stakeUsd: 50000, outcome: "YES", won: true, held: true, ts: 1700000000, tx: "0xaaa", eventGroup: "evt-fav",
        hz: { zBetCross: 5, zProfitCross: 5, lateBuyFraction: 0.9, directionalScore: 1.0 } },
      // a couple of small resolved losers (form a distribution; keep net P/L well positive)
      { cond: "0xb1", question: "m1", entryPrice: 0.5, stakeUsd: 1000, outcome: "NO", won: false, held: true, ts: 1700000100, tx: "0xbbb" },
      { cond: "0xb2", question: "m2", entryPrice: 0.4, stakeUsd: 1000, outcome: "NO", won: false, held: true, ts: 1700000200, tx: "0xccc" },
    ],
  };
  return Object.assign(base, over || {});
}

test("FAVORITE path: genuine favorite-insider (won + outsized + net-profitable + concealment) -> flagged", () => {
  const s = B.buildFavoriteSubject(favAgg(), 0, {}, {});
  assert.ok(s, "should publish a favorite subject");
  assert.equal(s.flaggedBy, "cross-sectional-profit");
  assert.equal(s.tier, "elevated", "z=5 with 1 structural signal caps at high/elevated (not extreme)");
  assert.ok(s.profitNum > 0, "net-positive flagged profit");
  assert.ok(!/1 in/.test(s.improbText), "no invalid normal-tail '1 in N' for heavy-tailed profit");
});

test("FAVORITE path: FRESH-ONLY (no concealment/cluster) -> NOT flagged (Polymarket proxy-wallet fix)", () => {
  // a winning outsized net-profitable favorite, FRESH wallet but NO concealment/cluster. fresh fires
  // on ~75% of Polymarket wallets (per-user proxy wallets), so it no longer satisfies the anti-whale
  // gate — otherwise the favorite path waves through whales. Only conceal/cluster count now.
  const s = B.buildFavoriteSubject(favAgg({ conceal: null }), 0, {}, {});
  assert.equal(s, null, "fresh alone is proxy-wallet noise on Polymarket — not a structural insider tell");
});

test("FAVORITE path: bare whale on a favorite (old wallet, no structure) -> NOT flagged", () => {
  const s = B.buildFavoriteSubject(favAgg({ priorTx: 500, firstSeenTs: 1699000000 + 400 * 86400, conceal: null }), 0, {}, {});
  assert.equal(s, null, "a smart whale with no on-chain structure must not pollute the validated view");
});

test("FAVORITE path: net-LOSING wallet that out-profited peers in one market -> NOT flagged", () => {
  // fresh wallet, same flagged episode, but overall the wallet LOST money (big losers) -> net-profit
  // gate rejects it. This is the exact archetype the old favorites pass false-flagged.
  const losers = favAgg();
  losers.bets.push({ cond: "0xL", question: "big loss", entryPrice: 0.5, stakeUsd: 80000, outcome: "NO", won: false, held: true, ts: 1700000300, tx: "0xddd" });
  const s = B.buildFavoriteSubject(losers, 0, {}, {});
  assert.equal(s, null, "out-profiting peers in ONE market while losing overall is not insider trading");
});

test("FAVORITE path: near-certainty favorite (97%) carries no edge -> NOT flagged", () => {
  const sure = favAgg();
  sure.bets[0].entryPrice = 0.97;                              // above FAV_MAX_ODDS (0.90)
  const s = B.buildFavoriteSubject(sure, 0, {}, {});
  assert.equal(s, null, "a near-certain favorite is a whale parking money, not informed trading");
});

test("buildPayload: favorite subject is folded into the ONE store, appears once", () => {
  const payload = B.buildPayload([favAgg()], {}, {});
  const favs = payload.subjects.filter((s) => s.flaggedBy === "cross-sectional-profit");
  assert.equal(favs.length, 1, "the favorite-insider is published once in the single store");
  assert.equal(payload.subjects.length, 1, "no duplicate row for the same wallet");
});

/* ============================================================================
 *  7-CASE UPGRADES — cross-category accuracy, repeat-offender, event-anchored timing,
 *  softened gates, rename/deletion proxy.
 * ========================================================================== */
test("crossCat: near-perfect MODERATE-odds record flags (AlphaRaccoon 22/23); long-shot book excluded", () => {
  const moderate = []; for (let i = 0; i < 23; i++) moderate.push({ impliedProb: 0.45, won: i < 22, eventGroup: "e" + i });
  const cc = D.crossCat(moderate);
  assert.equal(cc.hasData, true); assert.equal(cc.fires, true, "22/23 at 45% is improbable across categories");
  assert.ok(cc.z >= 3 && cc.improbDenom > 100, "real z + a genuine 1-in-N");
  // a long-shot-only book is the binomial `won`'s job — crossCat abstains (no double-count).
  const longshots = []; for (let i = 0; i < 10; i++) longshots.push({ impliedProb: 0.1, won: i < 6, eventGroup: "L" + i });
  assert.equal(D.crossCat(longshots).hasData, false, "blended long-shot odds -> covered by binomial, crossCat abstains");
  // a record at its own implied rate (no edge) does not fire.
  const fair = []; for (let i = 0; i < 20; i++) fair.push({ impliedProb: 0.5, won: i < 10, eventGroup: "f" + i });
  assert.equal(D.crossCat(fair).fires, false, "winning at the implied rate is not anomalous");
});

test("repeat: fires only across >=2 distinct surprising events", () => {
  const one = [{ entryPrice: 0.2, won: true, eventGroup: "a" }, { entryPrice: 0.25, won: true, eventGroup: "a" }];
  assert.equal(D.repeat(one).fires, false, "two wins in the SAME event is one event, not a repeat pattern");
  const many = [{ entryPrice: 0.2, won: true, eventGroup: "a" }, { entryPrice: 0.3, won: true, eventGroup: "b" }, { entryPrice: 0.15, won: true, eventGroup: "c" }];
  const r = D.repeat(many); assert.equal(r.fires, true); assert.equal(r.nEvents, 3);
  const favs = [{ entryPrice: 0.8, won: true, eventGroup: "a" }, { entryPrice: 0.75, won: true, eventGroup: "b" }];
  assert.equal(D.repeat(favs).hasData, false, "winning favorites isn't 'against the odds' -> not a surprise");
});

test("timing: EVENT-ANCHORED to the price-shock, not resolution", () => {
  // entered 2h before the price-shock, but 100 DAYS before official resolution. Resolution-anchoring
  // would call this 'not late'; shock-anchoring correctly flags the informed pre-event entry.
  const ts = 1700000000;
  const b = [{ entryPrice: 0.1, won: true, ts, shockTs: ts + 2 * 3600, resolvedMs: (ts + 100 * 86400) * 1000 }];
  const t = D.timing(b);
  assert.equal(t.anchored, true, "uses the price-shock anchor when present");
  assert.equal(t.fires, true, "bought 2h before the shock -> informed-entry signature");
  // without a shock anchor it falls back to resolution (here 100d out -> not late).
  const b2 = [{ entryPrice: 0.1, won: true, ts, resolvedMs: (ts + 100 * 86400) * 1000 }];
  assert.equal(D.timing(b2).fires, false, "resolution-anchored, 100d before -> not flagged");
});

test("concealment: anonymized-profile (rename/deletion) proxy is a tactic", () => {
  // a single on-chain tactic alone doesn't fire; with the anonymised-profile proxy two co-occur.
  const c = D.concealment({ cashoutLatencyHours: 2, anonymized: true });
  assert.equal(c.fires, true, "rapid cash-out + no public profile despite history -> 2 tactics");
  assert.ok(c.tactics.some((t) => /no public profile/.test(t)));
  assert.equal(D.concealment({ anonymized: false }).hasData, false, "no tactics, not anonymised -> no data");
});

test("crossCat publish path: moderate-odds serial winner is published over the FULL record", () => {
  const bets = [];
  for (let i = 0; i < 24; i++) bets.push({ cond: "0xc" + i, question: "m" + i, entryPrice: 0.45, stakeUsd: 2000,
    outcome: "YES", won: i < 22, held: true, ts: 1700000000 + i, tx: "0x" + i, eventGroup: "ev" + i });
  const agg = { address: "0xCROSScat000000000000000000000000000001", firstSeenTs: 1699000000, fundingTs: 1699000000, priorTx: 9,
    profile: { username: "alpha-like", pnlAllTime: 50000, volume: 48000 }, bets };
  const s = B.buildCrossCatSubject(agg, 0, {}, {});
  assert.ok(s, "should publish the cross-category serial winner");
  assert.equal(s.flaggedBy, "cross-category");
  assert.ok(/1 in/.test(s.improbText), "headline is a real cross-category improbability");
  assert.ok(s.profitNum > 0 && s.ledger.length >= 5, "net-positive, full-record ledger");
  // folded into the ONE store via buildPayload
  const payload = B.buildPayload([agg], {}, {});
  assert.equal(payload.subjects.filter((x) => x.flaggedBy === "cross-category").length, 1);
});

test("extractEntities: pulls SPECIFIC entities, drops generic market words (the fisheries fix)", () => {
  const ents = D.extractEntities("Will the 7-day moving average of transit calls through the Strait of Hormuz as reported by the IMF PortWatch be above 60 before August 1, 2026?");
  assert.ok(ents.includes("Strait of Hormuz"), "keeps the multi-word entity intact (connector preserved): " + JSON.stringify(ents));
  assert.ok(ents.some((e) => /PortWatch/.test(e)), "captures IMF PortWatch");
  assert.ok(!ents.some((e) => /moving|average|transit/i.test(e)), "drops the generic phrase that caused the competitor's false match");
  // ranked most-specific first
  assert.equal(ents[0].split(/\s+/).length >= 2, true, "multi-word entity ranks first");
  // a vague market yields nothing precise -> the news/reg detectors stay no-data (correct)
  assert.deepEqual(D.extractEntities("Will the price be above 50 this week?"), [], "no proper entity -> empty");
});

test("newsBlackout: fires only on an empty window UNDER an outsized bet", () => {
  const fire = D.newsBlackout({ articleCount: 0, windowHours: 24, outsized: true, entity: "Strait of Hormuz", hasQuery: true });
  assert.equal(fire.fires, true, "0 articles + outsized = blackout flag");
  const quietSmall = D.newsBlackout({ articleCount: 0, windowHours: 24, outsized: false, entity: "X", hasQuery: true });
  assert.equal(quietSmall.fires, false, "quiet but not outsized -> not flagged on timing alone");
  const loud = D.newsBlackout({ articleCount: 9, windowHours: 24, outsized: true, entity: "X", hasQuery: true });
  assert.equal(loud.fires, false, "news was present -> the bet may just be reacting to it");
  assert.equal(D.newsBlackout({ hasQuery: false }).hasData, false, "no entity to query -> no-data, not a fabricated flag");
});

test("fedRegister: TIMING — only credits a bet placed BEFORE the filing was published", () => {
  const bet = Date.parse("2026-06-01T00:00:00Z") / 1000;
  // doc published 19 days AFTER the bet → the wallet was positioned ahead of the filing → fires.
  const ahead = D.fedRegister({ hasQuery: true, entity: "Venezuela", betDate: bet, matches: [{ title: "Blocking Property of the Government of Venezuela", agency: "OFAC", date: "2026-06-20", url: "https://federalregister.gov/d/x" }] });
  assert.equal(ahead.fires, true); assert.equal(ahead.top.leadDays, 19, "19 days before the filing");
  assert.ok(/BEFORE/.test(ahead.explain) && ahead.top.url, "explain states the timing and carries the clickable link");
  assert.ok(ahead.score <= 0.6, "corroborator-level score, never dominant");
  // doc published BEFORE the bet → the action was already public → NOT credited.
  const after = D.fedRegister({ hasQuery: true, entity: "Venezuela", betDate: bet, matches: [{ title: "Blocking Property ... Venezuela", date: "2026-05-10", url: "y" }] });
  assert.equal(after.fires, false, "filing already public before the bet -> not insider, not credited");
  assert.equal(D.fedRegister({ hasQuery: true, entity: "Venezuela", matches: [] }).fires, false, "no title match -> no fire (kills the fisheries FP)");
  assert.equal(D.fedRegister({ hasQuery: false }).hasData, false);
});

// LIVE WATCHLIST (pre-resolution). Signals are observable AT PLACEMENT — none needs the market to
// resolve. Magnitude (vs market volume) is ONE dimension; news-blackout is the highest-weighted tell;
// the information-environment axis is DIRECTIONAL: publicInfo (a public news/filing PREDATED the bet)
// is EXCULPATORY and LOWERS the score, the opposite of the old "+ for any filing match".
test("watchlistScore: whale-share magnitude fires WITHOUT a peer sample", () => {
  // a global feed rarely carries ≥6 trades of the same open market, so the peer z-test would never
  // fire — the volume-share test must catch the whale. $12k into a market doing $100k/24h = 12% ≥ 8%.
  const r = D.watchlistScore({ sizeUsd: 12000, marketSizes: [], marketVolUsd: 100000, entryPrice: 0.6 });
  assert.ok(r.fired.includes("outsized"), "≥8% of 24h volume fires outsized with no peers: " + JSON.stringify(r.fired));
  assert.equal(r.volShare, 12, "volShare reported as a percent");
  // a small slice of a deep market is NOT a whale.
  const small = D.watchlistScore({ sizeUsd: 3000, marketSizes: [], marketVolUsd: 500000, entryPrice: 0.6 });
  assert.ok(!small.fired.includes("outsized"), "0.6% of volume is not outsized");
});

test("watchlistScore: outsized ALSO fires on large ABSOLUTE size (liquid-market whale)", () => {
  // a $40k bet on a DEEP market ($5M/24h) is <1% of volume — the volume-share test misses it, but it's
  // a whale by absolute size. This is the coverage hole insiders exploit on liquid markets.
  const big = D.watchlistScore({ sizeUsd: 40000, marketSizes: [], marketVolUsd: 5e6, entryPrice: 0.6 });
  assert.ok(big.fired.includes("outsized"), "≥$25k fires outsized even at <1% of a deep market: " + JSON.stringify(big.fired));
  assert.ok(big.volShare < 1, "and it is NOT a volume-share whale (" + big.volShare + "%)");
  // a $5k bet on the same deep market is neither big-abs nor a volume whale.
  const ok = D.watchlistScore({ sizeUsd: 5000, marketSizes: [], marketVolUsd: 5e6, entryPrice: 0.6 });
  assert.ok(!ok.fired.includes("outsized"), "$5k on a $5M market is not outsized");
});

test("watchlistScore: a single STRONG tell earns a watch; a lone whale needs a 2nd signal", () => {
  const THRESH = 30;
  // blackout (35) alone clears; repeat (30) alone clears — the strongest tells stand on their own.
  assert.ok(D.watchlistScore({ sizeUsd: 1000, marketSizes: [], blackout: true }).score >= THRESH, "blackout alone is a watch");
  assert.ok(D.watchlistScore({ sizeUsd: 1000, marketSizes: [], walletFlagged: true }).score >= THRESH, "repeat-suspect alone is a watch");
  // a lone whale (outsized 20) does NOT clear — big money alone isn't suspicious.
  assert.ok(D.watchlistScore({ sizeUsd: 40000, marketSizes: [], marketVolUsd: 5e6 }).score < THRESH, "a lone whale needs corroboration");
  // long-shot (25) + repeat (30) clears comfortably.
  const r = D.watchlistScore({ sizeUsd: 4000, marketSizes: [], marketVolUsd: 1e7, entryPrice: 0.09, walletFlagged: true });
  assert.ok(r.fired.includes("longshot") && r.fired.includes("repeat") && r.score >= THRESH, JSON.stringify(r.fired));
  // a long-shot bet at FAVORITE odds does NOT fire longshot.
  assert.ok(!D.watchlistScore({ sizeUsd: 4000, marketSizes: [], marketVolUsd: 1e7, entryPrice: 0.82 }).fired.includes("longshot"), "82% is not a long-shot");
});

test("watchlistScore: blackout is the highest tell; publicInfo is exculpatory (LOWERS the score)", () => {
  const base = { sizeUsd: 12000, marketSizes: [], marketVolUsd: 100000, entryPrice: 0.2 };  // outsized + longshot
  const blackout = D.watchlistScore(Object.assign({}, base, { blackout: true }));
  const publicInfo = D.watchlistScore(Object.assign({}, base, { publicInfo: true }));
  const neutral = D.watchlistScore(base);
  assert.ok(blackout.score > neutral.score, "a news blackout RAISES the score");
  assert.ok(publicInfo.score < neutral.score, "public info BEFORE the bet LOWERS the score (exculpatory)");
  assert.equal(neutral.score - publicInfo.score, 20, "publicInfo subtracts exactly 20");
  // blackout (35) is the single highest-weighted signal.
  const w = D.WATCH_W;
  assert.ok(w.blackout >= w.repeat && w.blackout >= w.outsized && w.blackout >= w.longshot, "blackout is weighted highest");
});

test("watchlistScore: a normal in-distribution favorite bet fires nothing", () => {
  const normal = D.watchlistScore({ sizeUsd: 105, marketSizes: [100, 120, 90, 110], marketVolUsd: 1e7, entryPrice: 0.55 });
  assert.equal(normal.score, 0, "an unremarkable trade scores 0");
});

test("softened gate: small net-positive profit is a TIER CAP, not an exclusion", () => {
  // validateSubject floor is now a tiny materiality ($250), not $5k — a $2k-profit improbable single
  // wallet is published (the tier cap handles confidence), but a net loser is still rejected.
  const ctx = { n: 6, k: 5, avgImplied: 15, winRate: 83, improbDenom: 5000, profitNum: 2000,
    bets: [{ entryPrice: 0.15, stakeUsd: 300, won: true, cond: "0x1" }], tier: "watch", isCluster: false, minProfit: 250 };
  assert.equal(B.validateSubject(ctx), null, "$2k net-positive clears the softened floor (was excluded by the old $5k floor)");
  assert.ok(/net unprofitable/.test(B.validateSubject(Object.assign({}, ctx, { profitNum: -500 }))), "net loser still rejected");
  assert.ok(/below net-profit floor/.test(B.validateSubject(Object.assign({}, ctx, { profitNum: 100 }))), "below the $250 materiality floor -> rejected");
});

test("corrKey + de-correlation: date-ladder variants of one event collapse to one", () => {
  // 6 correlated "US strikes Iran by <date>" wins must read as ONE event, not 6
  const bets = [];
  for (const d of ["February 28","March 1","March 2","March 3","March 4","March 5"]) {
    bets.push({ impliedProb: 0.10, won: true, question: "US strikes Iran by " + d + ", 2026?" });
  }
  // 5 genuinely independent winning events (so n=6 >= the binomial minimum and it scores)
  bets.push({ impliedProb: 0.10, won: true, question: "Maduro out by February 28, 2026?" });
  bets.push({ impliedProb: 0.10, won: true, question: "Netanyahu out by June 30?" });
  bets.push({ impliedProb: 0.12, won: true, question: "Khamenei out as Supreme Leader of Iran by Feb 28?" });
  bets.push({ impliedProb: 0.15, won: true, question: "US x Venezuela military engagement by Jan 15?" });
  bets.push({ impliedProb: 0.12, won: true, question: "Will Trump pardon someone by April?" });
  const r = D.won(bets);
  assert.ok(r.hasData, "scored");
  assert.equal(r.n, 6, "1 collapsed Iran-strike event + 5 independent = 6 events (not 11)");
  assert.ok(r.collapsed >= 5, "the 6 correlated Iran-strike bets collapsed to 1 (>=5 removed)");
});

test("corrKey: distinct underlying events keep distinct keys", () => {
  assert.equal(D.corrKey("US strikes Iran by March 1, 2026?"), D.corrKey("Will the US next strike Iran on Feb 27 (ET)?"), "same event, diff phrasing/date => same key");
  assert.notEqual(D.corrKey("US strikes Iran by March 1?"), D.corrKey("US x Venezuela military engagement by Jan 15?"), "different region => different key");
  assert.notEqual(D.corrKey("US strikes Iran by March 1?"), D.corrKey("Maduro out by Feb 28?"), "different topic => different key");
});
