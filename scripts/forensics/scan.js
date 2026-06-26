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

// SURPRISE-WEIGHTED DISCOVERY. Insiders cluster where an UNLIKELY outcome actually
// happened. For each resolved market we measure how improbable the realized outcome
// was — the stake-weighted entry price of the WINNING side (if winners bought in at
// 8%, the market gave it 8% and it happened anyway → surprise 0.92) — and keep the
// markets where a long-shot won AND real money rode it early. That ranked list is
// the haystack an investigator examines first; the wallets in it are scored as usual.
function recordSurprise(state, market, positions) {
  state.surpriseMarkets = state.surpriseMarkets || {};
  if (!market.category) return;                              // in-scope only (sports already excluded upstream)
  const winners = Object.values(positions).filter((p) => p.won);
  if (!winners.length) return;
  const stake = winners.reduce((a, p) => a + (Number(p.stakeUsd) || 0), 0);
  if (stake <= 0) return;
  const impliedWin = winners.reduce((a, p) => a + (Number(p.stakeUsd) || 0) * Number(p.entryPrice), 0) / stake;
  const surprise = 1 - impliedWin;                           // 1 = total shock, 0 = the favourite won
  if (surprise < 0.70) return;                               // only genuine long-shot upsets (winner ≤ ~30% implied)
  const big = winners.filter((p) => (Number(p.stakeUsd) || 0) >= 1000).sort((a, b) => b.stakeUsd - a.stakeUsd);
  state.surpriseMarkets[market.cond] = {
    cond: market.cond, q: market.question, url: market.url, category: market.category,
    winner: market.winner, impliedWin: +impliedWin.toFixed(4), surprise: +surprise.toFixed(4),
    winners: winners.length, bigEarly: big.length, totalStake: Math.round(stake),
    topStake: big[0] ? Math.round(big[0].stakeUsd) : 0,
    topWallets: big.slice(0, 5).map((p) => ({ a: p.address, stake: Math.round(p.stakeUsd), odds: +Number(p.entryPrice).toFixed(3) })),
    resolvedMs: market.resolvedMs || null,
  };
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
  if (!markets.length) { log("no resolved markets this slice; wrapping watermark to head."); state.watermark.offset = 0; await finalize(state, state.snapshotTs || NOW_S); return; }

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
    recordSurprise(state, m, positions);
    if (m.resolvedMs) newestResolved = Math.max(newestResolved, Math.round(m.resolvedMs / 1000));
    processed++;
    await poly.sleep(60);
  }
  state._catalog = catalog;        // handed to deep-enrich + persisted in finalize

  // ---- LIVE DISCOVERY FEED ----------------------------------------------------
  // Pull the most recent trades across ALL of Polymarket (no user filter) so
  // brand-new wallets are observed the MOMENT they trade, not only when the
  // resolved-market sweep eventually reaches their markets. Every distinct wallet
  // is folded into the all-time observed count (HLL) below; any whose trade lands
  // in a cataloged in-scope RESOLVED market is screened immediately, so a fresh
  // wallet that just won a long-shot enters the candidate pool the same tick.
  // This is what drives `observed` toward the full ~300k Polymarket population;
  // scoring still happens only on RESOLVED records (an open bet can't be scored).
  let liveTrades = 0, liveNew = 0, liveScreened = 0;
  try {
    const recent = await poly.recentTrades({ pages: +ENV.LIVE_PAGES || 12 });
    liveTrades = recent.length;
    const liveByMarket = {};
    for (const t of recent) {
      const w = t.proxyWallet || t.user || t.maker || t.taker;
      if (!w) continue;
      if (!state._reviewedThisRun.has(w)) liveNew++;
      state._reviewedThisRun.add(w);                          // → all-time observed (HLL)
      const cond = t.conditionId || t.market || t.condition_id;
      if (cond && catalog[cond]) (liveByMarket[cond] = liveByMarket[cond] || []).push(t);  // resolved + in-scope ⇒ screenable now
    }
    for (const cond of Object.keys(liveByMarket)) {
      const c = catalog[cond];
      const mk = { cond, eventGroup: c.s, question: c.q, category: c.c, winner: c.w,
        url: c.s ? "https://polymarket.com/event/" + c.s : "https://polymarket.com/markets",
        resolvedMs: c.r ? c.r * 1000 : null };
      const before = Object.keys(state.screened).length;
      const livePos = poly.aggregateMarket(mk, liveByMarket[cond]);
      mergeMarket(state, mk, livePos);
      recordSurprise(state, mk, livePos);                 // live-resolved upsets feed the haystack in near-real-time
      liveScreened += Math.max(0, Object.keys(state.screened).length - before);
    }
  } catch (e) { log("live feed skipped:", e && e.message); }
  log("live feed: " + liveTrades + " recent trades · " + liveNew + " new wallets discovered · " + liveScreened + " new resolved candidates screened");
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

  await finalize(state, state.snapshotTs);
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
async function finalize(state, snapshotTs) {
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

  // ---- surprise-weighted discovery: the markets where an unlikely outcome won and
  // real money rode it early — the haystack to investigate, with the wallets in it.
  // Bound the persisted set; publish the top 40 by surprise×money for the UI.
  const flaggedSet = new Set();
  payload.subjects.forEach((s) => (s.memberAddresses || [s.address]).forEach((a) => a && flaggedSet.add(String(a).toLowerCase())));
  const allSurprise = Object.values(state.surpriseMarkets || {});
  allSurprise.sort((a, b) => (b.surprise * Math.log10(Math.max(10, b.topStake))) - (a.surprise * Math.log10(Math.max(10, a.topStake))));
  if (allSurprise.length > 400) { const keep = {}; allSurprise.slice(0, 400).forEach((m) => (keep[m.cond] = m)); state.surpriseMarkets = keep; }
  payload.surpriseMarkets = allSurprise.slice(0, 40).map((m) => Object.assign({}, m, {
    topWallets: (m.topWallets || []).map((w) => Object.assign({}, w, { flagged: flaggedSet.has(String(w.a).toLowerCase()) })),
  }));
  log("surprise markets tracked: " + allSurprise.length + " (top surprise " + (allSurprise[0] ? Math.round(allSurprise[0].surprise * 100) + "%" : "—") + ")");

  // ---- lifecycle: persist first-flagged time; mark newly-flagged + archive ----
  state.flaggedHistory = state.flaggedHistory || {};
  payload.subjects.forEach((s) => {
    if (!state.flaggedHistory[s.id]) state.flaggedHistory[s.id] = NOW_S;
    s.firstFlaggedAt = state.flaggedHistory[s.id];
    s.newlyFlagged = (NOW_S - s.firstFlaggedAt) <= 86400;          // flagged within 24h
    s.archived = s.activityDays != null && s.activityDays > LOOKBACK_DAYS; // aged past the window
  });
  payload.clusters = clusterAggs.length;

  // ---- AUTO RING-FINDER: walk the on-chain funding graph from each flagged wallet,
  // pull in the siblings the sweep hasn't reached, and queue them for scoring next
  // tick — so a single flag expands into the whole ring (Iran-style 6-9 accounts,
  // one funder). Bounded + key-gated (the keyless RPC can't walk the tx graph).
  state.rings = state.rings || {};
  let ringsFound = 0, ringNew = 0;
  if (chain.hasScanKey() && payload.subjects.length) {
    const RING_BUDGET = +ENV.RING_BUDGET || 12;
    const targets = Array.from(new Set(payload.subjects.flatMap((s) => s.memberAddresses || [s.address]).filter(Boolean))).slice(0, RING_BUDGET);
    for (const addr of targets) {
      let net = null;
      try { net = await chain.fundingNetwork(addr, { maxSiblings: 40 }); } catch (_) {}
      if (!net || !net.hub) continue;
      const members = (net.nodes || []).filter((n) => n.role !== "exchange").map((n) => n.addr);
      if (members.length < 3) continue;                     // hub + subject + >=1 sibling
      ringsFound++;
      state.rings[net.hub] = { hub: net.hub, members, size: members.length, seedFrom: addr, ts: NOW_S };
      members.forEach((m) => {
        if (!state.screened[m]) {
          state.screened[m] = { address: m, bets: [], firstSeenTs: null, fundingTs: null, funder: net.hub, funderLabel: null, priorTx: null, cashoutLatencyHours: null, lastEnrichedTs: 0, lastTs: NOW_S, lastResolvedMs: 0, entryByEvent: {}, _ring: net.hub, _ringTs: NOW_S };
          ringNew++;
        } else if (!state.screened[m].funder) { state.screened[m].funder = net.hub; state.screened[m]._ring = net.hub; state.screened[m]._ringTs = NOW_S; }
      });
      await poly.sleep(220);                                // etherscan rate limit
    }
    const rk = Object.keys(state.rings);
    if (rk.length > 200) { const keep = {}; rk.sort((a, b) => (state.rings[b].ts || 0) - (state.rings[a].ts || 0)).slice(0, 200).forEach((k) => (keep[k] = state.rings[k])); state.rings = keep; }
  }
  payload.rings = Object.values(state.rings).filter((r) => (r.members || []).some((m) => flaggedSet.has(String(m).toLowerCase()))).length;
  log("ring-finder: " + ringsFound + " funding rings walked · " + ringNew + " new sibling wallets queued");

  log("flagged " + payload.subjects.length + " subjects (" +
    payload.subjects.filter((s) => s.tier === "extreme").length + " extreme · " +
    clusterAggs.length + " clusters · " + payload.subjects.filter((s) => s.newlyFlagged).length + " newly) from " + meta.reviewed + " reviewed");

  // ---- bound state.json WITHOUT breaking accumulation. A wallet's record only
  // matures as the sweep reaches its markets, so we RETAIN screened wallets across
  // the sweep. When the set exceeds SCREEN_CAP, evict by SIGNAL, not recency: the
  // screen admits any won long-shot (incl. $5 bets), so a recency cap was crowding
  // out the actual suspects (big-stake long-shot winners). Keep the wallets most
  // likely to ever clear the bar — biggest concentrated long-shot stake + most
  // long-shot wins — and drop the tiny one-off gamblers first.
  const sigScore = (w) => {
    const ls = (w.bets || []).filter((b) => num(b.entryPrice) <= 0.35);
    const wonLs = ls.filter((b) => b.won);
    const maxStake = wonLs.reduce((m, b) => Math.max(m, num(b.stakeUsd)), 0);
    const byEvent = {};
    wonLs.forEach((b) => { const e = b.eventGroup || b.cond; byEvent[e] = (byEvent[e] || 0) + num(b.stakeUsd); });
    const maxEventStake = Object.values(byEvent).reduce((m, s) => Math.max(m, s), 0);
    return Math.max(maxStake, maxEventStake) + wonLs.length * 750 + ls.length * 50;
  };
  const flaggedAddrs = new Set();
  payload.subjects.forEach((s) => (s.memberAddresses || [s.address]).forEach((a) => a && flaggedAddrs.add(a)));
  const RING_GRACE_S = 3 * 86400;   // newly-pulled ring siblings get 3 days to be enriched before they're evictable
  const addrs = Object.keys(state.screened);
  if (addrs.length > SCREEN_CAP) {
    const evictable = addrs.filter((a) => !flaggedAddrs.has(a))
      .filter((a) => { const w = state.screened[a]; return !(w && w._ringTs && (NOW_S - w._ringTs) < RING_GRACE_S); })
      .sort((a, b) => sigScore(state.screened[a]) - sigScore(state.screened[b]));   // lowest signal first
    const toEvict = evictable.slice(0, addrs.length - SCREEN_CAP);
    toEvict.forEach((a) => delete state.screened[a]);
    if (toEvict.length) log("evicted " + toEvict.length + " lowest-signal wallets (cap " + SCREEN_CAP + ") · " + Object.keys(state.screened).length + " retained");
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
