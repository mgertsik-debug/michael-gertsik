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

// numeric coerce — used by the eviction sigScore (and anywhere a bet field may be a
// string/undefined). Was referenced but never defined, so finalize() threw
// "num is not defined" at the eviction step once the screened pool first crossed
// SCREEN_CAP — crashing before write(STORE) and silently discarding every tick.
const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };

const DIR = path.resolve(__dirname, "../../data/forensics");
const STATE = path.join(DIR, "state.json");
const STORE = path.join(DIR, "store.json");
const REJECTED = path.join(DIR, "rejected.json");   // pre-publish gate: wallets dropped + why
const CATALOG = path.join(DIR, "markets.json");   // resolved-market winner catalog (cond -> {w,q,s,c,r})
const SEEDS = path.join(DIR, "seeds.json");        // publicly-reported wallets to force-enrich + score
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
// WALL-CLOCK BUDGET — the GitHub job is hard-killed at timeout-minutes (13m). If the
// enrich/ring-finder work runs past that, the COMMIT step never runs and the tick's
// results are LOST (the site never updates). So we self-impose a softer deadline:
// stop taking on new work once we cross it and go straight to finalize()+commit,
// leaving generous margin for the push. Coverage accumulates across ticks regardless.
const SCAN_BUDGET_MS = (+ENV.SCAN_BUDGET_S || 540) * 1000;     // default 9 min (job timeout 13m)
const RING_RESERVE_MS = (+ENV.RING_RESERVE_S || 120) * 1000;   // hold back ~2 min for the ring-finder
const DEADLINE = NOW + SCAN_BUDGET_MS;
const ENRICH_DEADLINE = NOW + SCAN_BUDGET_MS - RING_RESERVE_MS;
const overBudget = () => Date.now() > DEADLINE;             // hard wrap-up (used by the ring-finder)
const enrichOverBudget = () => Date.now() > ENRICH_DEADLINE; // earlier — leaves time for ring-tracing

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

  // ---- SEED publicly-reported / suspected wallets so they're force-enriched and
  // scored every tick, regardless of where the market-sweep frontier is. They get NO
  // special scoring — they run through the SAME detector suite and publish only if they
  // independently clear the bar. This just guarantees the known cases get a full record
  // (the sweep covers ~3.6k of 150k+ wallets, so it may never reach a given wallet).
  const seedCfg = read(SEEDS, { cases: [] }) || { cases: [] };
  state._userCache = state._userCache || {};            // resolved username -> address (persisted, resolve once)
  const seedAddrs = [];
  let resolvedNew = 0;
  for (const c of (seedCfg.cases || [])) {
    let a = String((c && c.address) || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a) && c && c.username) {
      const u = String(c.username).toLowerCase();
      if (state._userCache[u]) a = state._userCache[u];
      else { try { const r = await poly.resolveUsername(u); if (r) { a = r; state._userCache[u] = r; resolvedNew++; } } catch (_) {} }
    }
    if (!/^0x[0-9a-f]{40}$/.test(a)) continue;            // unresolved username -> skip this tick
    if (!state.screened[a]) state.screened[a] = { address: a, bets: [], firstSeenTs: null, fundingTs: null, funder: null, funderLabel: null, priorTx: null, cashoutLatencyHours: null, lastEnrichedTs: 0, lastTs: NOW_S, lastResolvedMs: 0, entryByEvent: {} };
    state.screened[a]._seed = true;
    state.screened[a]._seedCase = (c && c.case) || null;
    state.screened[a]._seedLabel = (c && c.label) || null;
    state.screened[a]._seedSource = (c && c.source) || null;
    seedAddrs.push(a);
  }
  if (seedAddrs.length) log("seeds: " + seedAddrs.length + " known-case wallets force-queued" + (resolvedNew ? " (" + resolvedNew + " username(s) resolved)" : ""));

  // 4. deep-enrich the stalest screened wallets (wallet age / funding recency).
  // Seeds go FIRST every tick (and bypass the wall-clock budget below) so the known
  // cases stay current even when enumeration eats the tick.
  const seedWallets = seedAddrs.map((a) => state.screened[a]).filter(Boolean);
  // PRIORITY: any wallet that has resolved bets but NO authoritative Polymarket profile yet
  // (e.g. enriched before the authoritative-P/L rollout) must be re-profiled FIRST — without
  // a profile the publish gate drops it, so a previously-flagged wallet would silently vanish
  // until it aged into staleness. Profile-less wallets sort ahead of the stalest by-time set.
  // wallets CURRENTLY shown on the site (the published store) must be re-profiled FIRST,
  // so the visible, possibly-wrong numbers are corrected on the very next scan rather than
  // waiting for these wallets to age into staleness.
  const priorFlagged = new Set();
  try { (read(STORE, {}).subjects || []).forEach((s) => (s.memberAddresses || [s.address]).forEach((a) => a && priorFlagged.add(String(a).toLowerCase()))); } catch (_) {}
  const nonSeed = Object.values(state.screened).filter((w) => !w._seed);
  const needsProfile = nonSeed.filter((w) => (w.bets || []).length && !w.profile)
    .sort((a, b) => (priorFlagged.has(String(b.address).toLowerCase()) ? 1 : 0) - (priorFlagged.has(String(a.address).toLowerCase()) ? 1 : 0));
  // PROMISE SCORE — rank the rest by how likely they are to flag HIGH, computed for FREE
  // from the partial record the cheap market-sweep already left on each wallet (no extra
  // API calls). The HIGH drivers: won long-shots at low odds (the binomial), the biggest
  // winning low-odds single bet (the conviction/big-trade signal), and one-sided exposure.
  // This surfaces likely insiders in 1-2 ticks instead of after a full round-robin rotation.
  // HONEST LIMIT: it can only see signal already swept — a wallet whose wins are all in
  // un-cataloged markets still looks boring here, so a COVERAGE RESERVE (a fraction of the
  // batch) stays pure round-robin so nothing promising-but-unseen is permanently starved.
  const promiseScore = (w) => {
    const bets = w.bets || [];
    let wonLow = 0, maxWinStake = 0, yes = 0, no = 0;
    for (const b of bets) {
      const ep = num(b.entryPrice), st = num(b.stakeUsd);
      if (b.won && ep > 0 && ep <= 0.15) { wonLow++; if (st > maxWinStake) maxWinStake = st; }
      if (String(b.outcome).toUpperCase() === "YES") yes += st; else no += st;
    }
    const purity = (yes + no) > 0 ? Math.max(yes, no) / (yes + no) : 0;
    return wonLow * 100 + Math.min(50, maxWinStake / 1000) + Math.round(purity * 20);
  };
  const rest = nonSeed.filter((w) => !((w.bets || []).length && !w.profile));
  const byPromise = rest.slice().sort((a, b) => promiseScore(b) - promiseScore(a));
  const byStale = rest.slice().sort((a, b) => (a.lastEnrichedTs || 0) - (b.lastEnrichedTs || 0));
  // blend: ~75% promise-ranked (find HIGH fast) + ~25% stalest (coverage so nothing starves)
  const COVER_FRAC = +ENV.COVERAGE_RESERVE_FRAC || 0.25;
  const promiseN = Math.round(ENRICH_BATCH * (1 - COVER_FRAC));
  const picked = new Set(), ordered = [];
  for (const w of byPromise) { if (ordered.length >= promiseN) break; if (!picked.has(w.address)) { picked.add(w.address); ordered.push(w); } }
  for (const w of byStale) { if (ordered.length >= ENRICH_BATCH) break; if (!picked.has(w.address)) { picked.add(w.address); ordered.push(w); } }
  const stale = seedWallets.concat(needsProfile, ordered).slice(0, seedWallets.length + needsProfile.length + ENRICH_BATCH);
  const topPromise = byPromise[0] ? promiseScore(byPromise[0]) : 0;
  if (needsProfile.length || byPromise.length) log("enrich order: " + needsProfile.length + " re-profile · promise-ranked (top score " + topPromise + ") + " + Math.round(COVER_FRAC * 100) + "% coverage reserve");
  let funded = 0;
  let fullRecords = 0;
  let posRecords = 0;                                          // wallets reconciled against /positions (authoritative cashPnl)
  let profiled = 0;                                            // wallets whose Polymarket profile aggregates were fetched
  let onDemandBudget = +ENV.ONDEMAND_PER_RUN || 1500;          // bound live CLOB resolution per run
  const PER_WALLET_ONDEMAND = +ENV.ONDEMAND_PER_WALLET || 80;
  let onDemandResolved = 0;
  let enrichedCount = 0;
  // Each wallet's ~6 network round-trips are INDEPENDENT across wallets, so we run a
  // bounded set CONCURRENTLY — the single biggest throughput win (Node overlaps the
  // I/O waits; the per-wallet awaits stay ordered). Shared counters/onDemandBudget
  // mutate only between awaits (single-threaded), so no data race — a tiny budget
  // overspend is fine. Concurrency itself paces requests, so the per-wallet sleep is gone.
  const ENRICH_CONCURRENCY = +ENV.ENRICH_CONCURRENCY || 5;
  async function enrichWallet(w) {
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
        // COMPLETE resolution for FLAG CANDIDATES. The shared on-demand budget is spread
        // across hundreds of screened wallets, so a non-candidate gets only a few markets
        // resolved — fine for cheap screening. But any wallet that could actually FLAG
        // (a known-case seed, a ring member, or one that already shows a winning long-shot)
        // is resolved COMPLETELY — every uncataloged market, uncapped, budget-exempt — so
        // its published dossier is its FULL resolved in-scope record, identical in depth to
        // the live search-bar lookup, never a 2-3-bet fragment.
        const _lsWins = (w.bets || []).filter((b) => (Number(b.entryPrice) || 1) <= 0.35 && b.won).length;
        const _candidate = w._seed || w._ring || _lsWins >= 1;
        if (onDemandBudget > 0 || _candidate) {
          const cat = state._catalog || (state._catalog = {});
          const missing = [];
          const seenM = new Set();
          for (const t of utrades) { const c = t.conditionId || t.market || t.condition_id; if (c && !cat[c] && !seenM.has(c)) { seenM.add(c); missing.push(c); } }
          if (missing.length) {
            const cap = _candidate ? missing.length : Math.min(PER_WALLET_ONDEMAND, onDemandBudget);
            const batch = missing.slice(0, cap);
            const resolved = await poly.marketsByConds(batch).catch(() => ({}));
            for (const c of Object.keys(resolved)) {
              if (!poly.category([], resolved[c].q)) continue;   // in-scope only (drop sports/crypto/etc)
              cat[c] = resolved[c]; onDemandResolved++;
            }
            if (!_candidate) onDemandBudget -= batch.length;
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

      // AUTHORITATIVE per-position reconciliation. The trades→catalog path reconstructs
      // P/L (assumes hold-to-resolution) and can only see markets in our catalog — that
      // is what made the dossier numbers diverge from Polymarket/predicts.guru (a wallet's
      // biggest winner sat in a market we hadn't cataloged, or its P/L ignored a partial
      // exit). Polymarket's /positions feed carries its OWN realized cashPnl and the
      // settled winner per position, and is catalog-INDEPENDENT, so we (a) overwrite each
      // matched bet's P/L + won with Polymarket's authoritative values and (b) RECOVER
      // resolved in-scope positions we never had. positionToBet() applies the same
      // in-scope/settled gate, so sports/crypto/open positions are still excluded.
      try {
        const positions = await poly.userPositions(w.address);
        const byCond = {}; (w.bets || []).forEach((b) => { byCond[b.cond] = b; });
        let recovered = 0, reconciled = 0;
        for (const p of positions) {
          const pb = poly.positionToBet(p);
          if (!pb) continue;
          const ex = byCond[pb.cond];
          if (ex) {
            if (pb.pnl != null) ex.pnl = pb.pnl;               // Polymarket's realized P/L wins over reconstruction
            ex.won = pb.won;                                   // authoritative settled outcome
            ex.held = pb.held;
            if (!ex.question && pb.question) ex.question = pb.question;
            if (!ex.url && pb.url) ex.url = pb.url;
            reconciled++;
          } else {
            w.bets.push(pb); byCond[pb.cond] = pb; recovered++;
            const ev = pb.eventGroup || pb.cond;
            if (pb.ts && (w.entryByEvent[ev] == null || pb.ts < w.entryByEvent[ev])) w.entryByEvent[ev] = pb.ts;
            if (pb.resolvedMs && pb.resolvedMs > (w.lastResolvedMs || 0)) w.lastResolvedMs = pb.resolvedMs;
          }
        }
        if (recovered || reconciled) posRecords++;
      } catch (_) { /* keep the trades record */ }

      // AUTHORITATIVE account aggregates — Polymarket's OWN profile figures (all-time
      // realized P/L, lifetime volume, prediction count, current portfolio value, handle).
      // These are the exact numbers the wallet's Polymarket profile shows (verified to the
      // dollar against live responses), so the dossier MIRRORS Polymarket. They drive the
      // headline P/L and the net-profit gate, replacing the subset reconstruction.
      try {
        const prof = await poly.profileAggregates(w.address);
        if (prof) { w.profile = prof; profiled++; }
      } catch (_) { /* leave any prior profile in place */ }

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
  }
  // run the stale list in concurrency-bounded batches; seeds (front of the list)
  // always run, non-seed batches stop at the wall-clock budget.
  for (let i = 0; i < stale.length; i += ENRICH_CONCURRENCY) {
    const batch = stale.slice(i, i + ENRICH_CONCURRENCY);
    if (!batch.some((w) => w._seed) && enrichOverBudget()) { log("enrich: hit wall-clock budget after " + enrichedCount + "/" + stale.length + " wallets — wrapping up (reserving time for ring-finder + commit)"); break; }
    await Promise.all(batch.map((w) => enrichWallet(w).catch(() => {})));
    enrichedCount += batch.length;
  }
  log("deep-enriched " + enrichedCount + " wallets (concurrency " + ENRICH_CONCURRENCY + ") · " + fullRecords + " full records · " + posRecords + " positions-reconciled · " + profiled + " profile aggregates · " + onDemandResolved + " markets resolved on-demand · " + funded + " funding traces" + (chain.hasScanKey() ? " (etherscan)" : " (public rpc)"));

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
  // cluster.pairLink computes co-spend as jaccard(betEvents) — but the scanner stores
  // the event set as the KEYS of entryByEvent, not a `betEvents` field. Without this
  // mapping co-spend was always 0, so wallets that bet the SAME markets never linked
  // (the Groups tab stayed empty). Derive betEvents from entryByEvent here.
  const enrichedForCluster = wallets.filter((w) => (w.bets || []).length)
    .map((w) => Object.assign({}, w, { betEvents: Object.keys(w.entryByEvent || {}) }));
  let clusters = [];
  try {
    // BUCKET BY FUNDER before clustering. A cluster needs a shared funder to clear the
    // 0.80 link threshold, so wallets that don't share a funder can't cluster anyway —
    // clustering WITHIN funder-buckets is O(Σ bucket²) instead of O(n²), which is what
    // lets the screened pool scale to tens of thousands. Skip singletons and giant
    // exchange-deposit buckets (>CLUSTER_BUCKET_MAX wallets = a hot wallet, not a ring).
    const CLUSTER_BUCKET_MAX = +ENV.CLUSTER_BUCKET_MAX || 500;
    const byFunder = {};
    enrichedForCluster.forEach((w) => { const f = w.funder ? String(w.funder).toLowerCase() : null; if (f) (byFunder[f] = byFunder[f] || []).push(w); });
    for (const f in byFunder) {
      const bucket = byFunder[f];
      if (bucket.length < 2 || bucket.length > CLUSTER_BUCKET_MAX) continue;
      clusters = clusters.concat(cluster.buildClusters(bucket));
    }
  } catch (e) { log("cluster pass failed (continuing single-wallet):", e && e.message); }
  const clustered = new Set();
  const clusterAggs = clusters.map((cl, i) => { cl.members.forEach((m) => clustered.add(m.address)); return cluster.clusterAggregate(cl, i); });
  if (clusters.length) log("cluster pass: " + clusters.length + " ring(s) merged, covering " + clustered.size + " wallets");

  // ---- single-wallet aggregates (excluding wallets folded into a cluster) ----
  const singleAggs = wallets.filter((w) => !clustered.has(w.address)).map((w) => ({
    address: w.address, firstSeenTs: w.firstSeenTs, fundingTs: w.fundingTs, priorTx: w.priorTx,
    conceal: walletConceal(w), bets: w.bets, _lastTs: w.lastTs,
    profile: w.profile || null,                               // Polymarket's authoritative account aggregates
  }));

  const meta = {
    observed: state.observed || 0,               // all-time distinct wallets seen (HLL)
    reviewed: state.reviewed || 0,               // distinct wallets scored this sweep
    screened: wallets.length,
    block: "",                                   // date-stamped snapshot (no fabricated block)
    snapshot: monthDay(snapshotTs),
    recomputed: monthDay(NOW_S),
    _rejects: [],                                // pre-publish gate fills this with {address, reason}
  };
  const payload = build.buildPayload(singleAggs.concat(clusterAggs), meta, state._catalog || {});

  // ---- category coverage: how many RESOLVED markets the scanner has cataloged in
  // each insider-tradeable category. The UI drives its category filter off this, so
  // every category being SCANNED is visible — not just the ones with a flag yet.
  const covCat = state._catalog || read(CATALOG, {}) || {};
  const coverageByCategory = {};
  for (const k in covCat) { const c = covCat[k] && covCat[k].c; if (c) coverageByCategory[c] = (coverageByCategory[c] || 0) + 1; }
  payload.coverageByCategory = coverageByCategory;

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
      if (overBudget()) { log("ring-finder: hit wall-clock budget — stopping after " + ringsFound + " rings"); break; }
      let net = null;
      try { net = await chain.fundingNetwork(addr, { maxSiblings: 40 }); } catch (_) {}
      if (!net || !net.hub) continue;
      const members = (net.nodes || []).filter((n) => n.role !== "exchange").map((n) => n.addr);
      if (members.length < 3) continue;                     // hub + subject + >=1 sibling
      ringsFound++;
      const hubNode = (net.nodes || []).find((n) => String(n.addr).toLowerCase() === String(net.hub).toLowerCase());
      state.rings[net.hub] = { hub: net.hub, hubLabel: (hubNode && hubNode.label) || net.hubLabel || null, members, nodes: net.nodes || [], size: members.length, seedFrom: addr, ts: NOW_S };
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
  // Publish the ring GROUPS the UI renders: every funding ring that touches at
  // least one flagged wallet, with per-member tier so the front end can colour the
  // graph. tierByAddr maps a member address -> its flagged tier (if any).
  const tierByAddr = {};
  payload.subjects.forEach((s) => (s.memberAddresses || [s.address]).forEach((a) => { if (a) tierByAddr[String(a).toLowerCase()] = s.tier; }));
  payload.ringGroups = Object.values(state.rings)
    .map((r) => {
      const members = (r.members || []).map((m) => {
        const lo = String(m).toLowerCase();
        return { addr: m, flagged: flaggedSet.has(lo), tier: tierByAddr[lo] || null };
      });
      const flaggedCount = members.filter((m) => m.flagged).length;
      return { hub: r.hub, hubLabel: r.hubLabel || null, size: r.size, seedFrom: r.seedFrom, ts: r.ts, flaggedCount, members };
    })
    .filter((g) => g.flaggedCount >= 1)                       // only rings that touch a flagged wallet
    .sort((a, b) => (b.flaggedCount - a.flaggedCount) || (b.size - a.size))
    .slice(0, 30);
  payload.rings = payload.ringGroups.length;
  log("ring-finder: " + ringsFound + " funding rings walked · " + ringNew + " new sibling wallets queued · " + payload.rings + " rings touch a flagged wallet");

  // ---- ROUTE RINGS INTO THE "GROUPS" TAB: turn each on-chain ring with >=2 betting
  // members into a CLUSTER SUBJECT, rendered with the full dossier UI. The shared
  // funder is CONFIRMED on-chain (the key-gated trace), which is stronger evidence
  // than buildClusters' inferred 0.80 threshold, so we build the cluster directly and
  // score the COMBINED record through the same suite — it publishes only if it clears
  // the bar. Members folded into a ring cluster are removed as single subjects.
  const ringClusterSubjects = [];
  const absorbed = new Set();
  // A CORROBORATED on-chain ring is a BUNDLE — the forensic unit is the ring (one entity
  // splitting across wallets), so its members are absorbed into the cluster and shown as the
  // Group, NOT also as solos (that would double-count and confuse). Solo subjects are the
  // wallets in NO bundle. A wallet that merely shares a funding service with others, with no
  // behavioral co-movement, fails the corroboration gate below and stays an independent single.
  Object.values(state.rings).forEach((r, ri) => {
    const memberW = (r.members || [])
      .map((a) => state.screened[String(a).toLowerCase()] || state.screened[a])
      .filter((w) => w && (w.bets || []).length);
    if (memberW.length < 2) return;                           // need >=2 betting members for a cluster record
    // REAL, MEASURED linkage — not a hardcoded 0.9. Shared on-chain funding alone is weak
    // (two strangers can fund through the same exchange/bridge/relayer), so a Group must
    // also show BEHAVIORAL corroboration: members actually bet the same markets (co-spend)
    // or entered in sync. We compute the true pairwise link (shared funder + co-spend +
    // sync + creation proximity) and require at least one pair to co-move beyond the funder.
    const memEnriched = memberW.map((w) => Object.assign({}, w, { betEvents: Object.keys(w.entryByEvent || {}) }));
    const edges = [];
    let coSpendMax = 0, syncMax = 0, proxMax = 0;
    for (let i = 0; i < memEnriched.length; i++) for (let j = i + 1; j < memEnriched.length; j++) {
      const pl = cluster.pairLink(memEnriched[i], memEnriched[j]);
      coSpendMax = Math.max(coSpendMax, pl.signals.coSpend);
      syncMax = Math.max(syncMax, pl.signals.syncEntry);
      proxMax = Math.max(proxMax, pl.signals.createProx);
      edges.push({ from: memberW[i].address, to: memberW[j].address, w: +pl.link.toFixed(2), link: pl.link, type: pl.type,
        evidence: pl.evidence + " · both funded on-chain from " + String(r.hub).slice(0, 10) + "…" + (r.hubLabel ? " (" + r.hubLabel + ")" : "") });
    }
    // CORROBORATION beyond the shared funder, so a coincidental shared on-ramp isn't a Group:
    //  • a ring of 3+ wallets one non-exchange address funded is itself coordinated (the hub
    //    excludes known CEXes), so it qualifies on size alone — these are the real insider rings
    //    (Maduro/Iran) whose members bet the SAME EVENT across different-dated markets (so the
    //    exact-market co-spend Jaccard is low even though they obviously co-move);
    //  • a 2-wallet ring needs behavioral co-movement: same markets, synced entry, or batch
    //    creation. Thresholds are deliberately lenient (lowered) — the shared NON-EXCHANGE
    //    funder already carries most of the weight.
    const CO_MIN = +ENV.RING_COSPEND_MIN || 0.05, SYNC_MIN = +ENV.RING_SYNC_MIN || 0.3, PROX_MIN = +ENV.RING_PROX_MIN || 0.5;
    const corroborated = memberW.length >= 3 || coSpendMax >= CO_MIN || syncMax >= SYNC_MIN || proxMax >= PROX_MIN;
    if (!corroborated) return;                                // 2-wallet, shared funder only, no co-movement → skip
    const volOf = (w) => (w.bets || []).reduce((s, b) => s + (Number(b.stakeUsd) || 0), 0);
    const order = memberW.map((w) => ({ w, vol: volOf(w) })).sort((a, b) => b.vol - a.vol);
    const nodes = order.map((o, rank) => {
      const lab = String(o.w.address).slice(0, 6) + "…";
      if (rank === 0) return { id: o.w.address, x: 0.5, y: 0.5, vol: 1, label: lab };
      const ang = (2 * Math.PI * (rank - 1)) / Math.max(1, order.length - 1);
      return { id: o.w.address, x: +(0.5 + 0.4 * Math.cos(ang)).toFixed(3), y: +(0.5 + 0.4 * Math.sin(ang)).toFixed(3),
        vol: +Math.max(0.3, o.vol / (order[0].vol || 1)).toFixed(2), label: lab };
    });
    const cexChips = r.hubLabel ? [String(r.hub).slice(0, 4) + "… " + r.hubLabel] : [];
    const meanLink = edges.length ? +(edges.reduce((a, e) => a + e.link, 0) / edges.length).toFixed(3) : 0;
    let subj = null;
    try {
      const agg = cluster.clusterAggregate({ members: memberW, edges, nodes, cexChips, meanLink, isCluster: true }, 9000 + ri);
      subj = build.buildSubject(agg, 9000 + ri, meta, state._catalog || {});
    } catch (_) {}
    if (subj) {
      if (!state.flaggedHistory[subj.id]) state.flaggedHistory[subj.id] = NOW_S;
      subj.firstFlaggedAt = state.flaggedHistory[subj.id];
      subj.newlyFlagged = (NOW_S - subj.firstFlaggedAt) <= 86400;
      ringClusterSubjects.push(subj);
      memberW.forEach((w) => absorbed.add(String(w.address).toLowerCase()));
    }
  });
  if (ringClusterSubjects.length) {
    build.derive(ringClusterSubjects);
    payload.subjects = payload.subjects.filter((s) => s.type === "cluster" || !absorbed.has(String(s.address).toLowerCase()));
    ringClusterSubjects.forEach((s) => payload.subjects.push(s));
    payload.subjects.sort((a, b) => b.improbDenom - a.improbDenom);
    payload.clusters = payload.subjects.filter((s) => s.type === "cluster").length;
    log("ring→cluster: published " + ringClusterSubjects.length + " on-chain ring(s) as Groups clusters");
  }
  // RECOMPUTE the headline aggregate P/L + count over the FINAL subject set. buildPayload()
  // computed these before the ring→cluster surgery (which adds Group subjects and removes
  // absorbed singles), so without this the top-line total omits the bundled groups — the
  // exact "doesn't add up across the groups" discrepancy. Now it sums every published subject.
  {
    const tot = payload.subjects.reduce((a, s) => a + (Number(s.profitNum) || 0), 0);
    const fmtUsd = (v) => (Math.abs(v) >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : Math.abs(v) >= 1e3 ? "$" + Math.round(v / 1e3) + "K" : "$" + Math.round(v));
    payload.totalFlaggedProfit = Math.round(tot);
    payload.totalFlaggedProfitText = fmtUsd(tot);
    payload.flaggedCount = payload.subjects.length;
    payload.scored = payload.scored || (payload.meta && payload.meta.scored) || 0;
  }

  log("flagged " + payload.subjects.length + " subjects (" +
    payload.subjects.filter((s) => s.tier === "extreme").length + " extreme · " +
    clusterAggs.length + " clusters · " + payload.subjects.filter((s) => s.newlyFlagged).length + " newly) from " + meta.reviewed + " reviewed");

  // PUBLISH the scored payload IMMEDIATELY — BEFORE the state housekeeping below —
  // so a bug in eviction/catalog-trim can never again discard a tick's results.
  // (A "num is not defined" crash in eviction silently froze the site for hours:
  // finalize threw before write(STORE), the top-level catch exited 0, and the
  // commit step saw no change.) The published store does not depend on housekeeping.
  write(STORE, payload);

  // ---- pre-publish gate: record what the validator DROPPED (and why), so false
  // positives / data-source bugs are visible instead of silent. Bounded to the most
  // recent 500. A reason like "improbDenom mismatch" or "bad entryPrice" points
  // straight at a calculation/source problem.
  const rejects = (meta._rejects || []).slice(0, 500);
  write(REJECTED, { generatedAt: monthDay(NOW_S), count: rejects.length, rejected: rejects });
  if (rejects.length) log("pre-publish gate: dropped " + rejects.length + " subject(s) that failed validation");

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
      .filter((a) => { const w = state.screened[a]; return !(w && w._seed); })   // never evict seeded known-case wallets
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
  // SHRINK state.json so the pool cap can go high without blowing git's 50MB/file
  // limit. state.json is committed every tick; at ~8KB/wallet a big pool would exceed
  // it. The dossier only ever DISPLAYS long-shot bets (≤0.35), so store FULL fields
  // only for those; favorites/losers keep just the fields scoring needs (stake,
  // outcome, eventGroup for concentration/sizing; entryPrice/won for P/L). This cuts
  // the per-wallet footprint several-fold. Scoring already ran above with full data.
  for (const a in state.screened) {
    const w = state.screened[a];
    if (!w || !Array.isArray(w.bets)) continue;
    w.bets = w.bets.map((b) => {
      // drop question/url everywhere (re-derived from the catalog at display time) and
      // priceStart/End (unused once resolved); keep tx only for long-shots (the dossier
      // shows tx links for those). Everything scoring needs is retained.
      const lean = { cond: b.cond, entryPrice: b.entryPrice, won: b.won, stakeUsd: b.stakeUsd,
        outcome: b.outcome, eventGroup: b.eventGroup, category: b.category, ts: b.ts, resolvedMs: b.resolvedMs, held: b.held };
      if (b.pnl != null) lean.pnl = b.pnl;                                   // Polymarket's authoritative P/L
      if (num(b.entryPrice) <= 0.35 && b.tx) lean.tx = b.tx;                 // tx link only matters for long-shots
      return lean;
    });
  }
  write(STATE, state);
  // (STORE was already written above, before housekeeping, so it lands even if the
  // eviction/catalog steps throw.)
}

// The catch exits 0 ON PURPOSE so the commit step still runs and persists whatever
// was written before the error — but write(STORE) now happens BEFORE any housekeeping,
// so a late crash no longer discards the tick. Log loudly so failures stay visible.
run().catch((e) => { log("fatal:", e && e.stack || e); process.exit(0); });
