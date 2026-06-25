/* ============================================================================
 *  forensics/cluster.js — wallet-cluster discovery (Meiklejohn-style linkage).
 *  ---------------------------------------------------------------------------
 *  Pure (only ./detectors.js). Given the screened wallets and the on-chain
 *  funding traces, build the pairwise link graph and merge wallets that bet as
 *  one entity:
 *      link(a,b) = w₁·shared_funder + w₂·co_spend + w₃·sync_entry + w₄·create_prox
 *  A cluster is a connected group whose MEAN pairwise link ≥ 0.80 (detectors’
 *  clusterTau). Links are PROBABILISTIC inferences, never confirmed common
 *  ownership — that caveat rides along on every cluster.
 *
 *  Wallet shape consumed (from the scanner):
 *    { address, funder?, firstSeenTs?, betEvents:Set|[], entryByEvent:{ev:ts},
 *      stakeByEvent:{ev:usd}, bets:[...], cexChips?:[] }
 * ========================================================================== */
"use strict";
const D = require("./detectors.js");

const lc = (a) => String(a || "").toLowerCase();
const SYNC_WINDOW = 15 * 60;          // 15-minute synchronized-entry window
const PROX_WINDOW = 2 * 86400;        // creation within 2 days → proximity
const EDGE_MIN = 0.45;                 // candidate edge to grow a component

const asSet = (x) => (x instanceof Set ? x : new Set(x || []));
function jaccard(a, b) {
  const A = asSet(a), B = asSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
// fraction of SHARED events both entered inside the sync window.
function syncFraction(wa, wb) {
  const ea = wa.entryByEvent || {}, eb = wb.entryByEvent || {};
  let shared = 0, sync = 0;
  for (const ev of Object.keys(ea)) {
    if (eb[ev] == null) continue;
    shared++;
    if (Math.abs(ea[ev] - eb[ev]) <= SYNC_WINDOW) sync++;
  }
  return shared ? sync / shared : 0;
}
function createProx(wa, wb) {
  if (!wa.firstSeenTs || !wb.firstSeenTs) return 0;
  const d = Math.abs(wa.firstSeenTs - wb.firstSeenTs);
  return d <= PROX_WINDOW ? +(1 - d / PROX_WINDOW).toFixed(3) : 0;
}

// pairwise link + the dominant signal (for the edge label the graph renders).
function pairLink(wa, wb) {
  const sharedFunder = wa.funder && wb.funder && lc(wa.funder) === lc(wb.funder) ? 1 : 0;
  const coSpend = jaccard(wa.betEvents, wb.betEvents);
  const syncEntry = syncFraction(wa, wb);
  const createProxV = createProx(wa, wb);
  const link = D.clusterLink({ sharedFunder, coSpend, syncEntry, createProx: createProxV });
  // Edge `type` must stay in the artifact graph's vocabulary {fund, cofund, sync,
  // create, transfer}. Co-spend feeds the link magnitude but isn't a graph type;
  // pick the strongest of fund/sync/create, else label co-funding.
  const w = D.DEFAULTS.clusterW;
  const typed = [["fund", w[0] * sharedFunder], ["sync", w[2] * syncEntry], ["create", w[3] * createProxV]];
  typed.sort((x, y) => y[1] - x[1]);
  const type = typed[0][1] > 0 ? typed[0][0] : "cofund";
  const evidence = {
    fund: sharedFunder ? ("both funded from " + (wa.funder ? lc(wa.funder).slice(0, 10) + "…" : "one address")) : "shared funding source",
    sync: "entered " + Math.round(syncEntry * 100) + "% of shared markets within " + Math.round(SYNC_WINDOW / 60) + " min",
    create: "wallets first seen within 2 days",
    cofund: "bet the same " + Math.round(coSpend * 100) + "% of markets together",
  }[type];
  return { link, type, evidence, signals: { sharedFunder, coSpend: +coSpend.toFixed(3), syncEntry: +syncEntry.toFixed(3), createProx: createProxV } };
}

// union-find connected components over candidate edges (link ≥ EDGE_MIN).
function components(wallets) {
  const parent = wallets.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  const pairCache = {};
  for (let i = 0; i < wallets.length; i++) {
    for (let j = i + 1; j < wallets.length; j++) {
      const pl = pairLink(wallets[i], wallets[j]);
      pairCache[i + ":" + j] = pl;
      if (pl.link >= EDGE_MIN) union(i, j);
    }
  }
  const groups = {};
  wallets.forEach((_, i) => { const r = find(i); (groups[r] = groups[r] || []).push(i); });
  return { groups: Object.values(groups).filter((g) => g.length >= 2), pairCache };
}

// circle layout for the connection graph (hub = highest volume at centre).
function layout(members, volOf) {
  const n = members.length;
  const order = members.map((m, i) => ({ m, i, vol: volOf(m) })).sort((a, b) => b.vol - a.vol);
  const nodes = [];
  order.forEach((o, rank) => {
    if (rank === 0) { nodes.push({ id: o.m.address, x: 0.5, y: 0.5, vol: 1, label: lc(o.m.address).slice(0, 4) + "…" }); return; }
    const ang = (2 * Math.PI * (rank - 1)) / Math.max(1, n - 1);
    nodes.push({ id: o.m.address, x: +(0.5 + 0.4 * Math.cos(ang)).toFixed(3), y: +(0.5 + 0.4 * Math.sin(ang)).toFixed(3), vol: +Math.max(0.3, o.vol / (order[0].vol || 1)).toFixed(2), label: lc(o.m.address).slice(0, 4) + "…" });
  });
  return nodes;
}

// Build clusters from screened wallets. Returns [{ members, edges, meanLink,
// nodes, cexChips, isCluster }] for groups whose mean pairwise link ≥ 0.80.
function buildClusters(wallets) {
  if (!Array.isArray(wallets) || wallets.length < 2) return [];
  const { groups, pairCache } = components(wallets);
  const out = [];
  for (const idxs of groups) {
    const edges = [];
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const i = Math.min(idxs[a], idxs[b]), j = Math.max(idxs[a], idxs[b]);
        const pl = pairCache[i + ":" + j];
        // `w` carries the real measured link so the graph shows true weights;
        // `type` keys the artifact's colours/labels.
        edges.push({ from: wallets[i].address, to: wallets[j].address, w: +pl.link.toFixed(2), link: pl.link, type: pl.type, evidence: pl.evidence });
      }
    }
    const cs = D.clusterScore(edges, idxs.length);
    if (!cs.hasData || !cs.isCluster) continue;
    const members = idxs.map((i) => wallets[i]);
    const volOf = (w) => (w.bets || []).reduce((s, x) => s + (Number(x.stakeUsd) || 0), 0);
    // keep the strongest edges for the graph (avoid a hairball on big rings)
    const topEdges = edges.slice().sort((x, y) => y.link - x.link).slice(0, Math.min(edges.length, members.length + 4));
    const cexChips = [];
    members.forEach((m) => { if (m.funderLabel && m.funder) { const chip = lc(m.funder).slice(0, 4) + "… " + m.funderLabel; if (!cexChips.includes(chip)) cexChips.push(chip); } });
    out.push({ members, edges: topEdges, meanLink: cs.meanLink, nodes: layout(members, volOf), cexChips, isCluster: true });
  }
  // largest / strongest first
  out.sort((a, b) => b.members.length - a.members.length || b.meanLink - a.meanLink);
  return out;
}

// Merge a cluster into a single aggregate for build.buildSubject(). Bets carry
// eventGroup so the binomial de-correlates shared underlying outcomes across the
// whole ring. Concealment split_ratio = share of events the ring co-entered.
function clusterAggregate(cluster, idx) {
  const members = cluster.members;
  const bets = [];
  members.forEach((m) => (m.bets || []).forEach((b) => bets.push(b)));
  // split ratio: fraction of distinct events that 2+ members entered together
  const evMembers = {};
  members.forEach((m) => Object.keys(m.entryByEvent || {}).forEach((ev) => { (evMembers[ev] = evMembers[ev] || new Set()).add(m.address); }));
  const evList = Object.keys(evMembers);
  const splitRatio = evList.length ? evList.filter((ev) => evMembers[ev].size >= 2).length / evList.length : 0;
  // decoy ratio across the ring (tiny bets vs large)
  const stakes = bets.map((b) => Number(b.stakeUsd) || 0).filter((x) => x > 0);
  const big = stakes.filter((s) => s >= 10000).length;
  const tiny = stakes.filter((s) => s > 0 && s < 200).length;
  const decoyRatio = big ? tiny / Math.max(big, 1) : 0;
  const cashout = members.map((m) => m.cashoutLatencyHours).filter((x) => x != null).sort((a, b) => a - b)[0];

  const firstSeenTs = Math.min(...members.map((m) => m.firstSeenTs || Infinity).filter(isFinite));
  const fundingTs = Math.min(...members.map((m) => m.fundingTs || Infinity).filter(isFinite));
  return {
    type: "cluster", id: "c" + (idx + 1), address: members[0].address,
    members: members.map((m) => m.address),
    edges: cluster.edges, nodes: cluster.nodes, cexChips: cluster.cexChips,
    firstSeenTs: isFinite(firstSeenTs) ? firstSeenTs : null,
    fundingTs: isFinite(fundingTs) ? fundingTs : null,
    priorTx: members.every((m) => m.priorTx === 0) ? 0 : null,
    conceal: { splitRatio: +splitRatio.toFixed(3), decoyRatio: +decoyRatio.toFixed(3), cashoutLatencyHours: cashout != null ? cashout : null },
    bets,
    _lastTs: Math.max(...members.map((m) => m.lastTs || 0)),
  };
}

module.exports = { pairLink, buildClusters, clusterAggregate, components, jaccard, syncFraction, createProx, SYNC_WINDOW, EDGE_MIN };
