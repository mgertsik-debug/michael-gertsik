#!/usr/bin/env node
/* ============================================================================
 *  scripts/forensics/scan.js — the wallet-forensics scheduled job.
 *  ---------------------------------------------------------------------------
 *  Runs on the static stack (GitHub Actions cron, no always-on process). Each
 *  tick advances a durable queue + watermark:
 *
 *    1. ENUMERATE a rolling batch of RESOLVED Polymarket markets (paginated).
 *    2. For each market pull wallet-level trades and AGGREGATE BY WALLET — the
 *       forensics pivot is the bettor's whole record across markets, not one
 *       market. Append each wallet's resolved bets to a persistent ledger.
 *    3. CHEAP-SCREEN: only wallets with a real position (≥ $SCREEN_USD at
 *       ≤ 35% implied) or an abnormal win streak enter the screened set.
 *    4. DEEP-ENRICH the N stalest screened wallets (wallet age / funding
 *       recency) — bounded by ENRICH_BATCH so each run fits the budget.
 *    5. SCORE every screened wallet with the unit-tested detector suite,
 *       fuse to a tier, and PERSIST the flagged subjects (the accumulating
 *       forensic ledger) to data/forensics/store.json for the read API.
 *    6. Maintain + LOG the rolling-coverage invariant; never advance the
 *       watermark on a failed fetch.
 *
 *  State (committed to the repo, like the Surveillance tab):
 *    data/forensics/state.json  — watermark, reviewed counter, screened ledger
 *    data/forensics/store.json  — the public, ranked, flagged payload
 *
 *  Env (all optional; safe defaults):
 *    LOOKBACK_DAYS=90  MARKETS_PER_RUN=120  ENRICH_BATCH=200
 *    SCREEN_USD=2500   MAX_STALENESS_DAYS=3
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const poly = require("../../api/forensics/poly.js");
const build = require("../../api/forensics/build.js");
const chain = require("../../api/forensics/chain.js");
const cluster = require("../../api/forensics/cluster.js");
const hll = require("../../api/forensics/hll.js");

const DIR = path.resolve(__dirname, "../../data/forensics");
const STATE = path.join(DIR, "state.json");
const STORE = path.join(DIR, "store.json");
const CATALOG = path.join(DIR, "markets.json");   // resolved-market winner catalog (cond -> {w,q,s,c,r})
const CATALOG_MAX = +process.env.CATALOG_MAX || 20000;

const ENV = process.env;
const LOOKBACK_DAYS = +ENV.LOOKBACK_DAYS || 90;
const MARKETS_PER_RUN = +ENV.MARKETS_PER_RUN || 120;
const ENRICH_BATCH = +ENV.ENRICH_BATCH || 200;
const SCREEN_USD = +ENV.SCREEN_USD || 2500;
const SCREEN_IMPLIED = 0.35;
const SCREEN_CAP = +ENV.SCREEN_CAP || 600;      // max wallets queued for enrichment (bounds state.json)
const MAX_STALENESS_DAYS = +ENV.MAX_STALENESS_DAYS || 3;
const NOW = Date.now();
const NOW_S = Math.round(NOW / 1000);

function read(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fb; } }
function write(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n"); }
function log(...a) { console.log("[forensics]", ...a); }

function monthDay(ts) {
  const d = new Date((ts || NOW_S) * 1000);
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return M[d.getUTCMonth()] + " " + String(d.getUTCDate()).padStart(2, "0") + " " + d.getUTCFullYear();
}

// merge a market's per-wallet positions into the persistent screened ledger.
// A wallet enters the ledger only once it clears the cheap screen on some bet.
function mergeMarket(state, market, positions) {
  const screened = state.screened;
  const reviewedSet = state._reviewedThisRun;
  const atCap = Object.keys(screened).length >= SCREEN_CAP;
  for (const addr of Object.keys(positions)) {
    const bet = positions[addr];
    reviewedSet.add(addr);
    // Cheap screen (§4) — the screen's only job is to bound /positions calls; the
    // binomial + ≥2-detector gate is the real, false-positive-proof filter, so cast
    // a WIDE net: ANY won long-shot (≤30% implied, any stake) — that's the whole
    // population of potential informed bettors — plus the big-position whale arm.
    // Every admitted wallet's FULL record is pulled and the math decides honestly.
    const wonLongshot = bet.won && bet.entryPrice <= 0.30;     // the actual candidate population
    const clears = wonLongshot ||
                   (bet.stakeUsd >= SCREEN_USD && bet.entryPrice <= SCREEN_IMPLIED);
    let w = screened[addr];
    // At cap we STILL admit a won-long-shot (the population we exist to score) —
    // finalize() evicts the least-active non-flagged wallet to make room. Only the
    // weaker big-position arm is deferred to the next sweep. Dropping won-long-shots
    // at the cap was silently starving the flag set.
    if (!w && atCap && !wonLongshot) continue;
    if (!w && !clears) continue;                              // not yet interesting
    if (!w) { w = screened[addr] = { address: addr, bets: [], firstSeenTs: null, fundingTs: null, funder: null, funderLabel: null, priorTx: null, cashoutLatencyHours: null, lastEnrichedTs: 0, lastTs: 0, lastResolvedMs: 0, entryByEvent: {} }; }
    bet.resolvedMs = market.resolvedMs || null;
    // dedup bets by (cond,outcome): keep the larger-stake record
    const key = bet.cond + "|" + bet.outcome;
    const existing = w.bets.find((b) => (b.cond + "|" + b.outcome) === key);
    if (existing) { if (bet.stakeUsd > existing.stakeUsd) Object.assign(existing, bet); }
    else w.bets.push(bet);
    if (bet.ts && bet.ts > (w.lastTs || 0)) w.lastTs = bet.ts;
    if (market.resolvedMs && market.resolvedMs > (w.lastResolvedMs || 0)) w.lastResolvedMs = market.resolvedMs;
    // synchronized-entry index: earliest entry per underlying event (for clustering)
    const ev = bet.eventGroup || bet.cond;
    if (ev && bet.ts && (w.entryByEvent[ev] == null || bet.ts < w.entryByEvent[ev])) w.entryByEvent[ev] = bet.ts;
  }
}

async function run() {
  fs.mkdirSync(DIR, { recursive: true });
  const state = read(STATE, null) || { watermark: { offset: 0 }, reviewed: 0, screened: {}, snapshotTs: 0 };
  state.screened = state.screened || {};
  state._reviewedThisRun = new Set();

  // 1+2. enumerate the NEXT slice of resolved markets (watermark sweep) and
  // aggregate by wallet. Each run resumes where the last left off, so over
  // successive ticks the whole rolling window is covered and each screened
  // wallet's full record accumulates (not just the freshest markets).
  state.watermark = state.watermark || { offset: 0 };
  let markets = [];
  try {
    markets = await poly.enumResolved({ lookbackDays: LOOKBACK_DAYS, startOffset: state.watermark.offset || 0, maxMarkets: MARKETS_PER_RUN, maxPages: Math.ceil(MARKETS_PER_RUN / 100) + 3 });
  } catch (e) { log("enumerate failed — not advancing:", e && e.message); }
  if (!markets.length) { log("no resolved markets this slice; wrapping watermark to head."); state.watermark.offset = 0; finalize(state, state.snapshotTs || NOW_S); return; }

  const nextOffset = markets.nextOffset != null ? markets.nextOffset : 0;
  const exhausted = !!markets.exhausted;
  markets = markets.slice(0, MARKETS_PER_RUN);

  // Resolved-market WINNER CATALOG (cond -> {w,q,s,c,r}). Persists + grows across
  // sweeps; it's what lets a wallet's full /trades history resolve to won/lost
  // bets in one pass. Every enumerated market is cataloged here.
  const catalog = read(CATALOG, {}) || {};
  markets.forEach((m) => { if (m.cond) catalog[m.cond] = { w: m.winner, q: m.question, s: m.eventGroup, c: m.category, r: m.resolvedMs ? Math.round(m.resolvedMs / 1000) : null }; });

  let newestResolved = state.snapshotTs || 0;
  let processed = 0;
  for (const m of markets) {
    if (!m.cond) continue;
    let trades = [];
    try { trades = await poly.tradesForMarket(m.cond); } catch (_) { trades = []; }
    if (!trades.length) continue;
    const positions = poly.aggregateMarket(m, trades);
    mergeMarket(state, m, positions);
    if (m.resolvedMs) newestResolved = Math.max(newestResolved, Math.round(m.resolvedMs / 1000));
    processed++;
    await poly.sleep(60);
  }
  state._catalog = catalog;        // handed to deep-enrich + persisted in finalize
  // `observed` = ALL-TIME DISTINCT wallets ever seen (HyperLogLog sketch, ~4 KB),
  // deduplicated, the single honest top-of-funnel. Every wallet touched this run is
  // folded in; the sketch persists across sweeps. `reviewed` mirrors it (same set,
  // same distinct count) — we do NOT keep a separate summed counter, which would
  // double-count wallets re-seen across runs and (wrongly) exceed `observed`.
  const sketch = hll.fromB64(state.hllB64);
  for (const a of state._reviewedThisRun) hll.add(sketch, a);
  state.hllB64 = hll.toB64(sketch);
  state.observed = hll.estimate(sketch);
  state.reviewed = state.observed;
  delete state.reviewedSweep; delete state.reviewedFull;     // retire the inflated counters
  state.snapshotTs = newestResolved || NOW_S;
  // advance (or wrap) the watermark so the next run sweeps the next slice
  state.watermark.offset = exhausted ? 0 : nextOffset;
  state.sweeps = (state.sweeps || 0) + (exhausted ? 1 : 0);
  log("processed " + processed + " markets · " + state._reviewedThisRun.size + " wallets touched · " + Object.keys(state.screened).length + " screened total · watermark→" + state.watermark.offset + (exhausted ? " (sweep " + state.sweeps + " complete, wrapped)" : ""));

  // 4. deep-enrich the stalest screened wallets (wallet age / funding recency)
  const stale = Object.values(state.screened)
    .sort((a, b) => (a.lastEnrichedTs || 0) - (b.lastEnrichedTs || 0))
    .slice(0, ENRICH_BATCH);
  let funded = 0;
  let fullRecords = 0;
  let onDemandBudget = +ENV.ONDEMAND_PER_RUN || 1500;          // bound live CLOB resolution per run
  const PER_WALLET_ONDEMAND = +ENV.ONDEMAND_PER_WALLET || 80;
  let onDemandResolved = 0;
  for (const w of stale) {
    try {
      const fs0 = await poly.firstSeen(w.address);
      if (fs0) w.firstSeenTs = fs0;
      // FULL record in one pass: the wallet's ENTIRE /trades history joined to the
      // resolved-market catalog → every bet in a known-resolved market, with its
      // true winner and entry odds. This is authoritative and complete (not the
      // current-holdings-only /positions feed). Merge by market — never overwrite —
      // so nothing already accumulated is lost.
      try {
        const haveConds = new Set((w.bets || []).map((b) => b.cond));
        const utrades = await poly.userTrades(w.address);
        // ON-DEMAND RESOLUTION: the static catalog only covers markets the sweep has
        // reached, so most of a wallet's trades resolve to NOTHING (avg 4.5 bets seen
        // vs hundreds real) — the engine then can't tell a multi-win insider from a
        // one-off. Resolve this wallet's UN-cataloged markets live (CLOB winner flag),
        // keep only in-scope ones, and fold them into the SHARED catalog so every
        // later wallet benefits too. Bounded per-wallet and per-run to fit the budget.
        if (onDemandBudget > 0) {
          const cat = state._catalog || (state._catalog = {});
          const missing = [];
          const seenM = new Set();
          for (const t of utrades) { const c = t.conditionId || t.market || t.condition_id; if (c && !cat[c] && !seenM.has(c)) { seenM.add(c); missing.push(c); } }
          if (missing.length) {
            const batch = missing.slice(0, Math.min(PER_WALLET_ONDEMAND, onDemandBudget));
            const resolved = await poly.marketsByConds(batch).catch(() => ({}));
            for (const c of Object.keys(resolved)) {
              if (!poly.category([], resolved[c].q)) continue;   // in-scope only (drop sports/crypto/etc)
              cat[c] = resolved[c]; onDemandResolved++;
            }
            onDemandBudget -= batch.length;
          }
        }
        const recBets = poly.buildUserRecord(utrades, state._catalog || {});
        let added = 0;
        recBets.forEach((b) => {
          if (haveConds.has(b.cond)) return;
          haveConds.add(b.cond); w.bets.push(b); added++;
          const ev = b.eventGroup || b.cond;
          if (b.ts && (w.entryByEvent[ev] == null || b.ts < w.entryByEvent[ev])) w.entryByEvent[ev] = b.ts;
          if (b.resolvedMs && b.resolvedMs > (w.lastResolvedMs || 0)) w.lastResolvedMs = b.resolvedMs;
        });
        if (added) fullRecords++;
      } catch (_) { /* keep the swept record */ }
      const firstBetTs = (w.bets || []).reduce((m, b) => (b.ts && b.ts < m ? b.ts : m), Infinity);
      // on-chain funding trace -> wallet age + prior-tx (fresh) + funder (cluster)
      const fund = await chain.walletFunding(w.address, isFinite(firstBetTs) ? firstBetTs : null, null);
      if (fund) {
        if (fund.ts) w.fundingTs = fund.ts;
        w.funder = fund.funder || null; w.funderLabel = fund.label || null;
        funded++;
      }
      const ptx = await chain.priorTxCount(w.address, isFinite(firstBetTs) ? firstBetTs : null);
      if (ptx != null) w.priorTx = ptx;
      // post-resolution cash-out latency (conceal tactic) for a real exchange hop
      if (w.lastResolvedMs) {
        const co = await chain.cashoutAfter(w.address, Math.round(w.lastResolvedMs / 1000));
        if (co) w.cashoutLatencyHours = co.latencyHours;
      }
      w.lastEnrichedTs = NOW_S;
    } catch (_) { /* leave stale; retry next run */ }
    await poly.sleep(40);
  }
  log("deep-enriched " + stale.length + " wallets · " + fullRecords + " full position records · " + onDemandResolved + " markets resolved on-demand · " + funded + " funding traces" + (chain.hasScanKey() ? " (etherscan)" : " (public rpc)"));

  // 6. rolling-coverage invariant
  const ages = Object.values(state.screened).map((w) => (NOW_S - (w.lastEnrichedTs || 0)) / 86400);
  const oldest = ages.length ? Math.max(...ages) : 0;
  log("coverage: oldest screened wallet enriched " + oldest.toFixed(1) + "d ago (invariant ≤ " + MAX_STALENESS_DAYS + "d)" + (oldest > MAX_STALENESS_DAYS ? " — BEHIND, will catch up next ticks" : " — OK"));

  finalize(state, state.snapshotTs);
}

// per-wallet concealment inputs from the bet record + chain cash-out. split_ratio
// only applies to clusters (one bet spread across linked wallets), so a lone
// wallet needs decoy + fast cash-out to fire (>=2 tactics) — never alone.
function walletConceal(w) {
  const stakes = (w.bets || []).map((b) => Number(b.stakeUsd) || 0).filter((x) => x > 0);
  const big = stakes.filter((s) => s >= 10000).length;
  const tiny = stakes.filter((s) => s > 0 && s < 200).length;
  const decoyRatio = big ? tiny / Math.max(big, 1) : 0;
  if (decoyRatio <= 0 && w.cashoutLatencyHours == null) return null;
  return { decoyRatio: +decoyRatio.toFixed(3), cashoutLatencyHours: w.cashoutLatencyHours != null ? w.cashoutLatencyHours : null };
}

// 5. cluster pass → score singles + clusters → lifecycle → persist.
function finalize(state, snapshotTs) {
  const wallets = Object.values(state.screened || {});

  // ---- cluster pass: discover linked rings over the screened set ----
  const enrichedForCluster = wallets.filter((w) => (w.bets || []).length);
  let clusters = [];
  try { clusters = cluster.buildClusters(enrichedForCluster); }
  catch (e) { log("cluster pass failed (continuing single-wallet):", e && e.message); }
  const clustered = new Set();
  const clusterAggs = clusters.map((cl, i) => { cl.members.forEach((m) => clustered.add(m.address)); return cluster.clusterAggregate(cl, i); });
  if (clusters.length) log("cluster pass: " + clusters.length + " ring(s) merged, covering " + clustered.size + " wallets");

  // ---- single-wallet aggregates (excluding wallets folded into a cluster) ----
  const singleAggs = wallets.filter((w) => !clustered.has(w.address)).map((w) => ({
    address: w.address, firstSeenTs: w.firstSeenTs, fundingTs: w.fundingTs, priorTx: w.priorTx,
    conceal: walletConceal(w), bets: w.bets, _lastTs: w.lastTs,
  }));

  const meta = {
    observed: state.observed || 0,               // all-time distinct wallets seen (HLL)
    reviewed: state.reviewed || 0,               // distinct wallets scored this sweep
    screened: wallets.length,
    block: "",                                   // date-stamped snapshot (no fabricated block)
    snapshot: monthDay(snapshotTs),
    recomputed: monthDay(NOW_S),
  };
  const payload = build.buildPayload(singleAggs.concat(clusterAggs), meta);

  // ---- lifecycle: persist first-flagged time; mark newly-flagged + archive ----
  state.flaggedHistory = state.flaggedHistory || {};
  payload.subjects.forEach((s) => {
    if (!state.flaggedHistory[s.id]) state.flaggedHistory[s.id] = NOW_S;
    s.firstFlaggedAt = state.flaggedHistory[s.id];
    s.newlyFlagged = (NOW_S - s.firstFlaggedAt) <= 86400;          // flagged within 24h
    s.archived = s.activityDays != null && s.activityDays > LOOKBACK_DAYS; // aged past the window
  });
  payload.clusters = clusterAggs.length;

  log("flagged " + payload.subjects.length + " subjects (" +
    payload.subjects.filter((s) => s.tier === "extreme").length + " extreme · " +
    clusterAggs.length + " clusters · " + payload.subjects.filter((s) => s.newlyFlagged).length + " newly) from " + meta.reviewed + " reviewed");

  // ---- bound state.json WITHOUT breaking accumulation. A wallet's record only
  // matures as the sweep reaches its markets, so we must RETAIN screened wallets
  // across the sweep (not drop them after one enrichment). When the set exceeds
  // SCREEN_CAP, evict the LEAST-ACTIVE wallets (oldest last bet) that are not
  // currently flagged — they're the least likely to ever clear the bar.
  const flaggedAddrs = new Set();
  payload.subjects.forEach((s) => (s.memberAddresses || [s.address]).forEach((a) => a && flaggedAddrs.add(a)));
  const addrs = Object.keys(state.screened);
  if (addrs.length > SCREEN_CAP) {
    const evictable = addrs.filter((a) => !flaggedAddrs.has(a))
      .sort((a, b) => (state.screened[a].lastTs || 0) - (state.screened[b].lastTs || 0));
    const toEvict = evictable.slice(0, addrs.length - SCREEN_CAP);
    toEvict.forEach((a) => delete state.screened[a]);
    if (toEvict.length) log("evicted " + toEvict.length + " least-active wallets (cap " + SCREEN_CAP + ") · " + Object.keys(state.screened).length + " retained");
  }

  // persist the resolved-market catalog, bounded to the most-recent CATALOG_MAX
  // (by resolution time) so the file can't grow without limit.
  if (state._catalog) {
    let cat = state._catalog;
    const conds = Object.keys(cat);
    if (conds.length > CATALOG_MAX) {
      const keep = conds.sort((a, b) => (cat[b].r || 0) - (cat[a].r || 0)).slice(0, CATALOG_MAX);
      const trimmed = {}; keep.forEach((c) => (trimmed[c] = cat[c])); cat = trimmed;
    }
    write(CATALOG, cat);
    log("catalog: " + Object.keys(cat).length + " resolved markets cataloged");
  }
  delete state._reviewedThisRun;
  delete state._catalog;
  write(STATE, state);
  write(STORE, payload);
}

run().catch((e) => { log("fatal:", e && e.stack || e); process.exit(0); });
