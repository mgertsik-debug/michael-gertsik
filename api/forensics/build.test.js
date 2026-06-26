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
  assert.equal(B.validateSubject(Object.assign({}, good, { profitNum: -5000, isCluster: true })), null);  // clusters exempt
  assert.match(B.validateSubject(Object.assign({}, good, { bets: [{ cond: "0xabc", entryPrice: 1.5, stakeUsd: 9000, won: true }] })), /entryPrice/);
  assert.match(B.validateSubject(Object.assign({}, good, { bets: [{ entryPrice: 0.11, stakeUsd: 9000, won: true }] })), /missing cond/);
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

test("AUTHORITATIVE P/L: headline profit is Polymarket's all-time figure, not the reconstruction", () => {
  // an improbable record whose per-bet reconstruction would sum to one number, but whose
  // Polymarket account P/L is a DIFFERENT, authoritative figure — the dossier must show
  // the authoritative one (so it always matches the wallet's Polymarket / predicts page).
  const a = agg("0xauth00000000000000000000000000000000a01", 14, 2, 0.11, "Military & Defense", { stake: 1500, profile: { pnlAllTime: 38244, volume: 249063, traded: 299 } });
  const s = B.buildSubject(a, 0, {});
  assert.ok(s, "subject built");
  B.derive([s]);
  assert.equal(s.profitNum, 38244, "profit is Polymarket's authoritative all-time P/L");
  assert.equal(s.profitSource, "authoritative");
  assert.equal(s.volumeNum, 249063, "volume is Polymarket's authoritative lifetime volume");
});

test("NET-NEGATIVE account: improbable run but a net loss on Polymarket -> dropped (the M888 case)", () => {
  // 14/16 long-shots at 11% is statistically extreme, but Polymarket says the account is
  // net-NEGATIVE all-time. Informed trading is profitable by definition, so this is a lucky
  // gambler, not an insider — it must NOT publish (no fabricated positive profit).
  const rejects = [];
  const s = B.buildSubject(agg("0xneg000000000000000000000000000000000a02", 14, 2, 0.11, "Military & Defense", { stake: 1500, profile: { pnlAllTime: -367249 } }), 0, { _rejects: rejects });
  assert.equal(s, null, "net-negative account is not flagged");
});

test("NO authoritative P/L: single wallet is DEFERRED, never published with an unsourced number", () => {
  const s = B.buildSubject(agg("0xnoprof000000000000000000000000000000a03", 14, 2, 0.11, "Military & Defense", { stake: 1500, profile: null }), 0, {});
  assert.equal(s, null, "no profile -> defer rather than fabricate");
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
