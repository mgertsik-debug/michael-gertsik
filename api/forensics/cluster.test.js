"use strict";
const test = require("node:test");
const assert = require("node:assert");
const C = require("./cluster.js");
const chain = require("./chain.js");

const wallet = (addr, funder, events, baseTs, stake) => {
  const entryByEvent = {}; events.forEach((e, i) => { entryByEvent[e] = baseTs + i * 60; });
  const bets = events.map((e, i) => ({ cond: e, eventGroup: e, question: "Q " + e, entryPrice: 0.09, stakeUsd: stake || 20000, outcome: "YES", won: true, held: true, ts: baseTs + i * 60, tx: "0x" + addr + i, category: "Military & Defense" }));
  return { address: addr, funder, funderLabel: chain.exchangeLabel(funder), firstSeenTs: baseTs - 86400, fundingTs: baseTs - 90000, priorTx: 0, lastTs: baseTs + 600, betEvents: new Set(events), entryByEvent, bets };
};

test("pairLink: same funder + synchronized shared markets -> high link", () => {
  const a = wallet("aaaa", "0xfund", ["e1", "e2", "e3"], 1700000000);
  const b = wallet("bbbb", "0xfund", ["e1", "e2", "e3"], 1700000000);
  const pl = C.pairLink(a, b);
  assert.ok(pl.link >= 0.8, "link should be high: " + pl.link);
  assert.equal(pl.signals.sharedFunder, 1);
  assert.ok(pl.signals.coSpend > 0.9);
});

test("pairLink: unrelated wallets -> low link", () => {
  const a = wallet("aaaa", "0xfund1", ["e1", "e2"], 1700000000);
  const b = wallet("bbbb", "0xfund2", ["x9", "x8"], 1800000000, 500);
  const pl = C.pairLink(a, b);
  assert.ok(pl.link < 0.45, "unrelated link should be low: " + pl.link);
});

test("buildClusters: a 6-wallet ring (shared funder, lockstep) forms ONE cluster", () => {
  const ts = 1700000000;
  const ring = ["w0", "w1", "w2", "w3", "w4", "w5"].map((a) => wallet(a, "0xf977814e90da44bfa03b6295a0616a897441acec", ["e1", "e2", "e3", "e4"], ts));
  const noise = wallet("n1", "0xother", ["z1", "z2"], 1500000000, 300);
  const clusters = C.buildClusters([...ring, noise]);
  assert.equal(clusters.length, 1, "exactly one cluster");
  assert.equal(clusters[0].members.length, 6);
  assert.ok(clusters[0].meanLink >= 0.8);
  assert.ok(clusters[0].nodes.length === 6);
  assert.ok(clusters[0].cexChips.length >= 1, "binance funder labelled");
  assert.ok(clusters[0].edges.length >= 5);
});

test("clusterAggregate: merges bets, computes split/decoy, ready for buildSubject", () => {
  const ts = 1700000000;
  const ring = ["w0", "w1", "w2", "w3"].map((a) => wallet(a, "0xfund", ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"], ts));
  const clusters = C.buildClusters(ring);
  assert.equal(clusters.length, 1);
  const ca = C.clusterAggregate(clusters[0], 0);
  assert.equal(ca.type, "cluster");
  assert.equal(ca.members.length, 4);
  assert.ok(ca.bets.length === 32, "8 events × 4 members merged");
  assert.ok(ca.conceal.splitRatio > 0.9, "ring co-entered nearly every event");
  assert.equal(ca.priorTx, 0);
});

test("chain pure helpers: pad/unpad address + USDC amount decode", () => {
  const padded = chain.padAddr("0xAbC0000000000000000000000000000000001234");
  assert.equal(padded.length, 66);
  assert.equal(chain.unpadAddr(padded), "0xabc0000000000000000000000000000000001234");
  assert.equal(chain.usdcAmount("0x0000000000000000000000000000000000000000000000000000000005f5e100"), 100); // 100e6
  assert.equal(chain.exchangeLabel("0xF977814e90dA44bFA03b6295A0616a897441aceC"), "Binance");
  assert.equal(chain.exchangeLabel("0xdeadbeef"), null);
});
