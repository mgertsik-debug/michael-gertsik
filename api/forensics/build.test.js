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
  const lossStake = (opts && opts.lossStake) || Math.round(stake / 2);
  for (let j = 0; j < nLoss; j++, i++) bets.push({ cond: "m" + i, eventGroup: "e" + i, question: "Market " + i, url: "#", category: cat, entryPrice: p, stakeUsd: lossStake, outcome: "YES", won: false, held: true, ts: 1700000000 + i, tx: "0xdef" + i });
  // Polymarket's authoritative account P/L is required to publish a single wallet. The
  // default is net-positive so flagged-record tests publish; tests can override via opts.
  const profile = (opts && opts.profile) || { pnlAllTime: 50000, volume: 30000, traded: 200, username: null };
  return Object.assign({ address, firstSeenTs: 1699000000, fundingTs: 1698900000, priorTx: 0, bets, profile }, opts || {});
}

test("betPL: uses Polymarket's real pnl when present, estimates only as fallback", () => {
  // real P/L from /positions (e.g. they sold early; pnl != naive payout)
  assert.equal(B.betPL({ won: true, entryPrice: 0.1, stakeUsd: 1000, pnl: 250 }), 250);
  assert.equal(B.betPL({ won: false, entryPrice: 0.1, stakeUsd: 1000, pnl: -1000 }), -1000);
  // no pnl -> estimate held-to-resolution payout
  assert.equal(B.betPL({ won: true, entryPrice: 0.1, stakeUsd: 1000 }), 1000 * (1 / 0.1 - 1));
  assert.equal(B.betPL({ won: false, entryPrice: 0.1, stakeUsd: 1000 }), -1000);
});

test("buildSubject: planted impossible single wallet -> High tier (no Extreme), real 1-in-N, real ledger", () => {
  const s = B.buildSubject(agg("0x4e00000000000000000000000000000000000a91c", 14, 2, 0.11, "Military & Defense"), 0, {});
  assert.ok(s, "subject built");
  B.derive([s]);                                  // apply the artifact-parity derivation
  assert.equal(s.type, "wallet");
  assert.equal(s.tier, "elevated");               // top published tier is High; there is no Extreme tier
  assert.equal(s.marketsCount, 16);
  assert.equal(s.wins, 14);
  assert.ok(s.improbDenom > 1e6, "headline far past 1-in-a-million: " + s.improbDenom);
  assert.ok(/^1 in /.test(s.improbText));
  assert.equal(s.ledger.length, 16);
  assert.ok(s.fired.includes("won"));
  const wonCard = s.scorecard.find((c) => c.key === "won");
  assert.ok(wonCard);
  // "show the math" inputs must be REAL bindings from this wallet (not placeholders)
  assert.ok(Array.isArray(wonCard.inputs) && wonCard.inputs.length, "won card carries real inputs");
  const nInput = wonCard.inputs.find((p) => p[0] === "n");
  assert.ok(nInput && /16/.test(nInput[1]), "n input reflects the real 16 bets: " + JSON.stringify(nInput));
  // derived fields the view reads
  assert.ok(s.percentile > 99);
  assert.ok(s.volumeNum > 0);
});

test("C1 fresh honesty: UNMEASURED priorTx (null) must NOT fire 'purpose-built wallet'", () => {
  // young wallet (funded ~1 day before its first bet) so fresh's age arm is satisfied.
  // priorTx === null means the Polygonscan prior-tx fetch FAILED — fresh must degrade to
  // no-data, never fabricate priorTx=0 and accuse the wallet of being purpose-built.
  const r = B.scoreAggregate(agg("0x5e00000000000000000000000000000000000c1f", 6, 2, 0.12, "Military & Defense", { priorTx: null }));
  assert.equal(r.dets.fresh.hasData, false, "null priorTx -> fresh no-data (no fabricated priorTx=0)");
  // sanity: a MEASURED priorTx=0 on the same young wallet DOES legitimately fire fresh
  const r2 = B.scoreAggregate(agg("0x5e00000000000000000000000000000000000c20", 6, 2, 0.12, "Military & Defense", { priorTx: 0 }));
  assert.equal(r2.dets.fresh.hasData, true, "measured priorTx=0 -> fresh has data");
  assert.equal(r2.dets.fresh.fires, true, "measured priorTx=0 on a young wallet -> fresh fires");
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

test("validateSubject: passes a clean record, rejects inconsistent/unsourced ones", () => {
  const good = { n: 16, k: 14, avgImplied: 11, winRate: 88, improbDenom: 4200000, profitNum: 50000, tier: "extreme",
    bets: [{ cond: "0xabc", entryPrice: 0.11, stakeUsd: 9000, won: true }], won: { hasData: false }, convOnly: false };
  assert.equal(B.validateSubject(good), null);
  assert.match(B.validateSubject(Object.assign({}, good, { k: 20 })), /k out of range/);
  assert.match(B.validateSubject(Object.assign({}, good, { avgImplied: 250 })), /avgImplied/);
  assert.match(B.validateSubject(Object.assign({}, good, { improbDenom: 0 })), /improbDenom/);
  // NET PROFITABILITY: a flagged wallet that lost money overall is a gambler, not an insider
  assert.match(B.validateSubject(Object.assign({}, good, { profitNum: -5000 })), /net unprofitable/);
  // CLUSTERS are held to the SAME net-positive bar (a ring's profitNum is its POOLED P/L). A
  // net-LOSING ring (e.g. a 28-wallet funder bucket down $10k) is proxy wallets gambling, not an
  // insider ring — it must be rejected, not exempt (the old exemption published a "$-10K" suspect).
  assert.match(B.validateSubject(Object.assign({}, good, { profitNum: -5000, isCluster: true })), /net unprofitable/);
  assert.equal(B.validateSubject(Object.assign({}, good, { profitNum: 50000, isCluster: true })), null);  // a PROFITABLE ring still passes
  assert.match(B.validateSubject(Object.assign({}, good, { bets: [{ cond: "0xabc", entryPrice: 1.5, stakeUsd: 9000, won: true }] })), /entryPrice/);
  assert.match(B.validateSubject(Object.assign({}, good, { bets: [{ entryPrice: 0.11, stakeUsd: 9000, won: true }] })), /missing cond/);
  // ACCOUNT NET-NEGATIVE is a blanket veto (precision guard) — a net-losing account is not a credible
  // insider regardless of episode size; a large reconstructed win against a negative account is the
  // signal the profit was not KEPT (the edgeseekr false-positive class). See NET-LOSING ACCOUNT test.
  assert.match(B.validateSubject(Object.assign({}, good, { accountPL: -40000, profitNum: 50000 })), /net-negative/);
});

test("buildSubject: pre-publish gate logs rejects into opts._rejects and returns null", () => {
  // a record that scores but we corrupt via a poisoned bet → must be dropped + logged
  const a = agg("0xbad0000000000000000000000000000000000001", 14, 2, 0.11, "Military & Defense", { stake: 1500 });
  a.bets[0].entryPrice = 0;                          // impossible odds (still ≤0.35, so it's scored) → fails validation
  const rejects = [];
  const s = B.buildSubject(a, 0, { _rejects: rejects }, {});
  assert.equal(s, null);
  assert.ok(rejects.length >= 1 && /entryPrice/.test(rejects[0].reason), "logged reason: " + JSON.stringify(rejects));
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

test("FORENSIC P/L: profit is the FLAGGED BETS' P/L (reconciles to the ledger); account P/L is context", () => {
  // The dossier headline P/L must be the realized P/L of the long-shot bets it shows — so it
  // reconciles to the bet table — NOT the wallet's account-wide Polymarket figure. The account
  // figure is carried separately as context (it can dwarf the flagged bets when the wallet
  // also earned on trades we don't flag).
  const a = agg("0xauth00000000000000000000000000000000a01", 14, 2, 0.11, "Military & Defense", { stake: 1500, profile: { pnlAllTime: 38244, volume: 249063, traded: 299 } });
  const s = B.buildSubject(a, 0, {});
  assert.ok(s, "subject built");
  B.derive([s]);
  assert.ok(s.profitNum > 50000, "profit is the flagged-bet sum (14 wins at 11%), not the $38k account figure: " + s.profitNum);
  assert.equal(s.accountPnl, 38244, "account P/L carried separately as context");
  assert.equal(s.profitSource, "flagged-bets");
  assert.equal(s.volumeNum, 249063, "volume is Polymarket's authoritative lifetime volume");
});

test("FLAGGED BETS net-negative: improbable WIN RATE but losing bets outweigh the wins -> dropped", () => {
  // 6 of 20 won at 10% (an improbable rate), but the LOSING bets carried far bigger stakes, so
  // the flagged long-shots NET a loss. The account is hugely positive (it earned elsewhere) —
  // but we flag the BETS, not the account, so a wallet whose suspicious bets lost is not an
  // insider. This is the @lmtfalone case ($135k account, money-losing flagged bets).
  const rejects = [];
  const s = B.buildSubject(agg("0xneg000000000000000000000000000000000a02", 6, 14, 0.10, "Military & Defense", { stake: 200, lossStake: 2000, profile: { pnlAllTime: 500000 } }), 0, { _rejects: rejects });
  assert.equal(s, null, "flagged bets net-negative -> dropped even though the ACCOUNT is +$500k");
});

test("NO profile: still publishes on the flagged-bet P/L (profile only adds context, not required)", () => {
  const s = B.buildSubject(agg("0xnoprof000000000000000000000000000000a03", 14, 2, 0.11, "Military & Defense", { stake: 1500, profile: null }), 0, {});
  assert.ok(s && s.tier, "publishes on the flagged-bet record; profile not required");
  assert.equal(s.accountPnl, null, "no account context when the profile is unavailable");
});

test("TRIVIAL flagged-bet profit: improbable record but the flagged bets net under the floor -> dropped", () => {
  // improbable rate but tiny stakes -> the flagged bets net only a few hundred dollars. No solo
  // insider risks exposure for that, so it's dropped. (Clusters are exempt — a bundle splits.)
  const s = B.buildSubject(agg("0xtiny000000000000000000000000000000aa04", 6, 2, 0.12, "Military & Defense", { stake: 40, lossStake: 400 }), 0, {});
  assert.equal(s, null, "sub-floor flagged-bet profit (tiny stakes) is dropped");
  // a wallet whose flagged bets clear the floor still publishes
  const ok = B.buildSubject(agg("0xover000000000000000000000000000000aa05", 14, 2, 0.11, "Military & Defense", { stake: 1500 }), 0, {});
  assert.ok(ok && ok.tier, "flagged-bet profit above the floor publishes");
});

test("NET-LOSING ACCOUNT: improbable, material long-shot streak but all-time P/L < 0 -> dropped", () => {
  // The edgeseekr case: a real but tiny improbable streak on an account that LOST money overall
  // (−$23 all-time). An insider profits; a net-loser who got lucky on a few bets is not informed.
  const s = B.buildSubject(agg("0xloss000000000000000000000000000000aa06", 14, 2, 0.11, "Politics", { stake: 1500, profile: { pnlAllTime: -23, volume: 30000, traded: 464, username: "edgeseekr" } }), 0, {});
  assert.equal(s, null, "net-negative all-time account P/L is dropped even with an improbable record");
  // same record, account net-positive -> publishes (the streak itself is fine; only the loss gates it)
  const ok = B.buildSubject(agg("0xprof000000000000000000000000000000aa07", 14, 2, 0.11, "Politics", { stake: 1500, profile: { pnlAllTime: 9000, volume: 30000, traded: 464, username: "winner" } }), 0, {});
  assert.ok(ok && ok.tier, "net-positive account with the same record publishes");
});

test("UNIFORM dossier: a record-flagged wallet shows BOTH record cards AND cross-sectional z-cards", () => {
  // The owner flagged that record-flagged dossiers spoke "record metrics" while Harvard-flagged ones
  // spoke "z-scores". Every wallet computes BOTH, so every dossier must now show BOTH vocabularies.
  // A long-shot RECORD wallet whose biggest bet ALSO carries a qualifying cross-section (outsized +
  // out-profited + won) must render the record detectors AND the 5 Harvard z-signals, no duplicates.
  const bets = [];
  for (let i = 0; i < 7; i++) bets.push({ cond: "0xc" + i, question: "Market " + i + "?", eventGroup: "ev" + i,
    entryPrice: 0.12, won: true, stakeUsd: 5000 + i * 100, outcome: "Yes", category: "Military & Defense",
    ts: 1700000000 + i * 86400, resolvedMs: (1700000000 + i * 86400 + 3600) * 1000, held: true, pnl: 30000, hz: null });
  bets[0].stakeUsd = 60000; bets[0].pnl = 80000;
  bets[0].hz = { zBetCross: 9.2, zProfitCross: 11.4, lateBuyFraction: 0.7, directionalScore: 0.98,
    profitUsd: 80000, stakeUsd: 60000, mktMeanProfit: 1000, mktSdProfit: 7000, mktMeanStake: 1500, mktSdStake: 6000, nBuyers: 40, marketVol: 500000 };
  const agg = { address: "0xUNIFORM0000000000000000000000000000aa01", bets, firstSeenTs: 1699000000, fundingTs: 1698000000, priorTx: 0, profile: { pnlAllTime: 200000 } };
  const s = B.buildSubject(agg, 0, {});
  assert.ok(s, "subject built");
  const keys = (s.scorecard || []).map((c) => c.key);
  assert.ok(keys.some((k) => ["won", "longshot", "timing", "sizing"].includes(k)), "has RECORD cards: " + keys.join(","));
  assert.ok(keys.includes("hProfit") && keys.includes("hBetCross") && keys.includes("hBetWithin"), "has cross-sectional z cards: " + keys.join(","));
  assert.equal(keys.length, new Set(keys).size, "no duplicate scorecard keys");
});

test("RECONSTRUCTED Iran-ring cluster aggregate -> High-tier subject with cluster card", () => {
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
  B.derive([s]);                                  // production re-bins the final tier (no Extreme)
  assert.equal(s.type, "cluster");
  assert.equal(s.tier, "elevated");               // top published tier is High; there is no Extreme tier
  assert.ok(s.fired.includes("cluster"));
  assert.ok(s.fired.includes("won"));
  assert.ok(s.scorecard.find((c) => c.key === "cluster"));
  assert.ok(s.cluster && s.cluster.size === 9);
});

test("bhThreshold: Benjamini-Hochberg adaptive FDR cutoff", () => {
  // classic BH example (Benjamini & Hochberg 1995): p-values, q=0.05 → cutoff 0.0125
  const p = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.3240,
            0.4262, 0.5719, 0.6528, 0.7590, 1.0000];
  const t = B.bhThreshold(p, 0.05, 0);
  assert.equal(t, 0.0095, "largest p-value that satisfies p(k) <= (k/m)q");
  // too-small a family: returns 1 (don't tighten the fixed bar)
  assert.equal(B.bhThreshold(p, 0.05, 500), 1, "below minPop -> no correction");
  // nothing significant -> 0
  assert.equal(B.bhThreshold([0.9, 0.95, 0.99], 0.05, 0), 0, "no p clears -> drop all");
});

test("FDR control only ever TIGHTENS the binomial bar (precision-only)", () => {
  // a strong improbable record survives FDR even amid a large scored population
  const opts = { _scoredDenoms: [] };
  // seed the scored population with many UNremarkable wallets (p ~ 1) + this strong one
  for (let i = 0; i < 600; i++) opts._scoredDenoms.push(1.2);   // ~p=0.83, noise
  const s = B.buildSubject(agg("0xstrong0000000000000000000000000000a08", 16, 1, 0.08, "Politics", { stake: 4000 }), 0, opts);
  // build a payload containing just this strong wallet; its tiny p must clear BH
  const payload = B.buildPayload([agg("0xstrong0000000000000000000000000000a08", 16, 1, 0.08, "Politics", { stake: 4000 })], {}, {});
  assert.ok(payload.subjects.length >= 1, "a genuinely improbable, material, net-positive record still publishes under FDR");
  assert.ok(payload.meta.fdr, "FDR summary is surfaced in meta");
});
