/* ============================================================================
 *  forensics/detectors.js — pure wallet-forensics detectors (Polymarket)
 *  ---------------------------------------------------------------------------
 *  Zero dependencies. Retrospective: the SUBJECT is the bettor (wallet or linked
 *  cluster), not the market. Each detector returns a sub-score in [0,1], the raw
 *  inputs it used, a plain-English explainer, and hasData. hasData=false means
 *  the inputs were missing → the detector is EXCLUDED from the score, never
 *  scored 0. Every flag is "pattern consistent with informed trading — not
 *  proof." No ML, no heavy deps; transparent statistics a lawyer can follow.
 *
 *  Methods (exactly the methodLib() contract the Wallet Forensics artifact uses):
 *    won       Binomial improbability  P(X>=k) = Σ C(n,i) p^i (1-p)^(n-i)   [headline]
 *    longshot  favourite–longshot      p̄ = mean implied, flag if <= 0.20
 *    held      hold-to-resolution      h = held/total, flag if >= 0.90
 *    fresh     wallet-age/funding      age <= 14d AND prior_tx = 0
 *    baseline  won-vs-category baseline (ACDC: 52% mil / 25% pol / 14% all)
 *    conceal   concealment signatures  >=2 of {split, decoy, fast cash-out}
 *    cluster   linkage  link = w1·funder + w2·co_spend + w3·sync + w4·prox
 *  fuse() combines FIRED detectors with the artifact contribution weights and
 *  tiers by the binomial thresholds AND a >=2-agreeing-detector gate.
 *
 *  Unit-tested by detectors.test.js (`node --test api/forensics/`).
 * ========================================================================== */
"use strict";

const isNum = (x) => typeof x === "number" && isFinite(x);
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---- tuning / thresholds (the artifact's contract; one exported home) ----- */
const DEFAULTS = {
  // binomial tiering (artifact: Extreme if P<=1e-6, High if P<=1e-4)
  pExtreme: 1e-6, pHigh: 1e-4, pNotable: 1e-2,
  minBets: 5,                      // < 5 resolved bets -> hasData=false (small samples are garbage)
  // detector firing thresholds
  longshotTau: 0.20,
  heldTau: 0.90,
  freshAgeDays: 14,
  // concealment
  concealMinTactics: 2, splitTau: 0.5, decoyTau: 0.3, cashoutFastHours: 24,
  // single high-conviction bet (the lone insider bet the binomial can't see):
  // a large stake (≥$10k) on a DEEP long-shot (≤15% implied) that won + was held.
  convictionUsd: 7500, convictionTau: 0.15,  // event-concentrated stake; calibrated to the confirmed Maduro insiders ($9.9k+)
  // INFORMED ENTRY TIMING — bought cheap, LATE, right before a surprise it then won.
  // Van Dyke bet the night before; the Iran ring bought hours before at ~10c. A
  // winning ≤20%-implied bet entered within this window of resolution is the tell.
  timingTau: 0.20, timingWindowH: 72,
  // DIRECTIONAL / EVENT CONCENTRATION — Van Dyke was 100% YES, 13/13, in one cluster.
  // purity = max(yes,no stake)/total; fires only with real money behind it so a
  // single-direction $50 gambler doesn't trip it. Common alone → low weight, and
  // it needs >=concMinBets so it stays inert on the single-bet conviction archetype.
  concDirTau: 0.95, concMinUsd: 10000, concMinBets: 3,
  // WITHIN-TRADER BET-SIZE ANOMALY (Harvard "within-trader bet size") — the informed
  // bet dwarfs the wallet's own norm. top event stake vs the wallet's MEDIAN bet;
  // fires if >= sizingMult× median AND >= sizingFloorUsd absolute. Needs >=sizingMinBets
  // (a distribution), so it can't collude with `conviction` on a lone-bet wallet.
  sizingMult: 8, sizingFloorUsd: 3000, sizingMinBets: 4,
  // cluster linkage weights (w1 funder, w2 co-spend, w3 sync-entry, w4 create-prox)
  clusterW: [0.40, 0.25, 0.20, 0.15], clusterTau: 0.80,
  // fusion contribution weights (artifact contributionMap + conviction). Ordered by
  // discriminating power: rare+causal signals (won/cluster/conviction/timing) weigh
  // most; common-alone signals (fresh/concentration/held) least.
  contribW: { won: 32, cluster: 22, conviction: 20, timing: 16, conceal: 14, sizing: 12, longshot: 11, fresh: 8, concentration: 7, held: 6 },
  agreeSub: 0.45,                  // a detector "agrees" when its sub-score >= this
  minAgree: 2,                     // High/Extreme needs >= 2 independent detectors
  // win-rate baselines on <=35%-implied bets, by category (ACDC-derived)
  winBaseline: {
    "military & defense": 0.52, "politics": 0.25, "elections": 0.25, "world": 0.30,
    "economics": 0.18, "economy": 0.18, "finance": 0.18, "crypto": 0.12, "culture": 0.30,
    "sports": 0.08, all: 0.14,
  },
  categoryRisk: {                  // role/category risk weight (military/exec highest)
    "military & defense": 1.25, "world": 1.15, "politics": 1.15, "elections": 1.15,
    "economics": 1.05, "economy": 1.05, "finance": 1.05, "culture": 0.95, "crypto": 0.9, "sports": 0.85,
  },
};
function winBaseline(cat) { const b = DEFAULTS.winBaseline[String(cat || "").toLowerCase()]; return isNum(b) ? b : DEFAULTS.winBaseline.all; }
function categoryRisk(cat) { const r = DEFAULTS.categoryRisk[String(cat || "").toLowerCase()]; return isNum(r) ? r : 1; }

/* ---- log-gamma (Lanczos) for a numerically-stable binomial tail ----------- */
function lgamma(x) {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const logChoose = (n, k) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

// P(X >= k) for X ~ Binomial(n, p), computed in log-space (handles tiny tails).
function binomTailGE(n, k, p) {
  if (!(n > 0) || k <= 0) return 1;
  if (k > n) return 0;
  p = clip(p, 1e-12, 1 - 1e-12);
  const lp = Math.log(p), lq = Math.log(1 - p);
  const terms = [];
  for (let i = Math.ceil(k); i <= n; i++) terms.push(logChoose(n, i) + i * lp + (n - i) * lq);
  let m = -Infinity; for (const tt of terms) if (tt > m) m = tt;
  if (!isFinite(m)) return 0;
  let s = 0; for (const tt of terms) s += Math.exp(tt - m);
  return clip(Math.exp(m + Math.log(s)), 0, 1);
}

// "1 in N" formatting for a probability.
function improbDenom(P) { return P > 0 ? Math.round(1 / P) : Infinity; }
function improbText(denom) {
  if (!isFinite(denom) || denom >= 1e12) return "1 in >1T";   // beyond ~1-in-a-trillion: astronomically improbable
  if (denom >= 1e9) return "1 in " + (denom / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (denom >= 1e6) return "1 in " + (denom / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (denom >= 1e3) return "1 in " + (denom / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return "1 in " + Math.max(1, Math.round(denom));
}

/* ============================================================================
 *  DE-CORRELATION — collapse bets on the SAME underlying outcome.
 *  Many bets on one event (correlated) would inflate the binomial. We collapse
 *  each `eventGroup` to ONE effective bet: won = did they (net) win that event,
 *  p = mean implied across the group. Bets with no eventGroup are singletons.
 *  Returns { n, k, p, collapsed } over independent effective bets. */
function decorrelate(bets) {
  const groups = new Map();
  for (let idx = 0; idx < bets.length; idx++) {
    const b = bets[idx];
    const key = b.eventGroup != null ? "g:" + b.eventGroup : "s:" + idx;
    const g = groups.get(key) || { ps: [], wins: 0, n: 0 };
    g.ps.push(clip(b.impliedProb, 1e-6, 1 - 1e-6)); g.n++; if (b.won) g.wins++;
    groups.set(key, g);
  }
  let n = 0, k = 0, psum = 0, collapsed = 0;
  for (const g of groups.values()) {
    n += 1;
    const won = g.wins * 2 >= g.n;            // net win on that underlying outcome
    if (won) k += 1;
    psum += g.ps.reduce((a, b) => a + b, 0) / g.ps.length;
    if (g.n > 1) collapsed += g.n - 1;
  }
  return { n, k, p: n ? psum / n : 0, collapsed };
}

/* ============================================================================
 *  1. WON — binomial improbability (the headline). De-correlated.
 *  bets: [{ impliedProb (0..1, entry odds), won (bool), eventGroup? }]
 *  Only resolved bets should be passed. < minBets -> hasData=false. */
function won(bets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!Array.isArray(bets)) return { key: "won", hasData: false };
  const resolved = bets.filter((b) => b && isNum(b.impliedProb) && typeof b.won === "boolean");
  const { n, k, p, collapsed } = decorrelate(resolved);
  if (n < o.minBets) return { key: "won", hasData: false, n, reason: "fewer than " + o.minBets + " independent resolved bets" };
  const expected = +(n * p).toFixed(2);
  const P = binomTailGE(n, k, p);
  const denom = improbDenom(P);
  // sub-score saturates as P crosses the Extreme threshold (log scale)
  const score = clip((Math.log10(Math.max(P, 1e-15)) - Math.log10(o.pNotable)) / (Math.log10(o.pExtreme) - Math.log10(o.pNotable)), 0, 1);
  return {
    key: "won", hasData: true, score,
    n, k, p: +p.toFixed(4), expectedWins: expected, P, improbDenom: denom, improbText: improbText(denom),
    collapsed, winRate: +(100 * k / n).toFixed(1),
    explain: "Won " + k + " of " + n + " independent bets the market priced at ~" + Math.round(p * 100) +
      "% — about " + expected + " expected by luck. Probability by chance ≈ " + improbText(denom) +
      (collapsed ? " (" + collapsed + " correlated bets de-correlated)." : "."),
  };
}

/* 2. LONGSHOT — mean implied entry odds. Fires if p̄ <= τ. */
function longshot(impliedProbs, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const ps = (impliedProbs || []).filter(isNum);
  if (!ps.length) return { key: "longshot", hasData: false };
  const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
  const fires = mean <= o.longshotTau;
  const score = clip((o.longshotTau - mean) / o.longshotTau, 0, 1) * (fires ? 1 : 0.3);
  return { key: "longshot", hasData: true, score: fires ? clip(0.45 + 0.55 * score, 0, 1) : clip(score, 0, 0.4),
    mean: +mean.toFixed(4), n: ps.length, fires,
    explain: "Average entry odds ~" + Math.round(mean * 100) + "% across " + ps.length + " bets" +
      (fires ? " — concentrated in long shots (≤" + Math.round(o.longshotTau * 100) + "%)." : ".") };
}

/* 3. HELD — hold-to-resolution rate. Fires if h >= 0.90. */
function held(x, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!x || !isNum(x.heldToResolution) || !isNum(x.total) || x.total <= 0) return { key: "held", hasData: false };
  const h = clip(x.heldToResolution / x.total, 0, 1);
  const fires = h >= o.heldTau;
  return { key: "held", hasData: true, score: fires ? clip(0.4 + (h - o.heldTau) / (1 - o.heldTau) * 0.6, 0, 1) : clip(h * 0.4, 0, 0.4),
    h: +h.toFixed(3), heldToResolution: x.heldToResolution, total: x.total, fires,
    explain: x.heldToResolution + " of " + x.total + " positions held to resolution (" + Math.round(h * 100) + "%)" +
      (fires ? " — held ≥" + Math.round(o.heldTau * 100) + "% of positions to the outcome; the conviction signature." : ".") };
}

/* 4. FRESH — wallet age + funding recency. Fires if age <= 14d AND prior_tx = 0. */
function fresh(x, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!x || !isNum(x.ageDays) || !isNum(x.priorTx)) return { key: "fresh", hasData: false };
  const fires = x.ageDays <= o.freshAgeDays && x.priorTx === 0;
  const score = fires ? clip(1 - x.ageDays / o.freshAgeDays, 0.5, 1) : clip(0.3 * (1 - clip(x.ageDays / 90, 0, 1)), 0, 0.4);
  return { key: "fresh", hasData: true, score, ageDays: x.ageDays, priorTx: x.priorTx, fires,
    explain: fires
      ? "Account first bet ~" + (x.ageDays < 1 ? Math.round(x.ageDays * 24) + "h" : x.ageDays.toFixed(1) + "d") + " after funding, with no prior transactions — a purpose-built wallet."
      : "Wallet age " + x.ageDays.toFixed(0) + "d, " + x.priorTx + " prior transactions." };
}

/* 5. BASELINE — realized win rate vs the category baseline (context for `won`). */
function baseline(x) {
  if (!x || !isNum(x.winRate)) return { key: "baseline", hasData: false };
  const base = winBaseline(x.category);
  const wr = x.winRate > 1 ? x.winRate / 100 : x.winRate;       // accept 94 or 0.94
  const ratio = base > 0 ? wr / base : 0;
  return { key: "baseline", hasData: true, score: clip((ratio - 1) / 4, 0, 1),
    winRate: +(wr * 100).toFixed(1), baseline: +(base * 100).toFixed(0), categoryRisk: categoryRisk(x.category),
    explain: "Won " + Math.round(wr * 100) + "% vs a ~" + Math.round(base * 100) + "% baseline for " +
      (x.category || "all") + " bets at ≤35% implied." };
}

/* 6. CONCEAL — concealment signatures. Fires only if >= 2 tactics co-occur. */
function concealment(x, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!x) return { key: "conceal", hasData: false };
  const splitRatio = isNum(x.splitRatio) ? x.splitRatio : null;       // one bet spread across linked wallets
  const decoyRatio = isNum(x.decoyRatio) ? x.decoyRatio : null;       // tiny decoy bets / real bets
  const cashoutH = isNum(x.cashoutLatencyHours) ? x.cashoutLatencyHours : null; // resolution -> off-platform
  if (splitRatio == null && decoyRatio == null && cashoutH == null) return { key: "conceal", hasData: false };
  const tactics = [];
  if (splitRatio != null && splitRatio >= o.splitTau) tactics.push("stake-splitting across linked wallets");
  if (decoyRatio != null && decoyRatio >= o.decoyTau) tactics.push("decoy small bets");
  if (cashoutH != null && cashoutH <= o.cashoutFastHours) tactics.push("rapid off-platform cash-out");
  const fires = tactics.length >= o.concealMinTactics;
  return { key: "conceal", hasData: true, score: fires ? clip(0.4 + 0.2 * tactics.length, 0, 1) : clip(0.15 * tactics.length, 0, 0.39),
    tactics, nTactics: tactics.length, fires,
    explain: fires ? tactics.length + " concealment tactics co-occur: " + tactics.join(", ") + "."
      : (tactics.length ? "One concealment tactic (" + tactics[0] + ") — not enough alone." : "No concealment tactics detected.") };
}

/* ============================================================================
 *  8. CONVICTION — a single high-stakes long-shot win (the LONE insider bet).
 *  The binomial needs >=5 bets, so it can't see a one-shot insider like the
 *  Van Dyke / Maduro case ($32k at ~8% → ~$400k). One bet isn't statistically
 *  "improbable" (it's the market's own odds), so this NEVER flags alone — it's a
 *  strengthening signal that, with fresh / conceal / category-risk corroboration,
 *  surfaces the single-bet insider archetype. bets: same shape as won().
 *  resolution time is the bet's; held defaults true unless explicitly false. */
function conviction(bets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const odds = (b) => (isNum(b.entryPrice) ? b.entryPrice : b.impliedProb);  // accept either field
  const resolved = (bets || []).filter((b) => b && isNum(odds(b)) && typeof b.won === "boolean");
  const wins = resolved.filter((b) => b.won && odds(b) <= o.convictionTau && b.held !== false);
  if (!wins.length) return { key: "conviction", hasData: false };
  // EVENT-CONCENTRATION: an insider knows ONE thing and bets it hard across ALL the
  // related markets, so we sum the staked conviction by EVENT, not by single bet.
  // Van Dyke spread ~$32k across several Maduro-capture date-markets — no single bet
  // is the signal, the concentrated event position is. (Reduces to single-bet
  // behaviour when each win is its own event.) p = stake-weighted entry odds.
  const byEvent = {};
  for (const b of wins) {
    const ev = b.eventGroup || b.question || b.cond || "?";
    const e = byEvent[ev] || (byEvent[ev] = { ev, stake: 0, wsum: 0, market: b.question || ev, markets: 0 });
    const s = Number(b.stakeUsd) || 0;
    e.stake += s; e.wsum += s * clip(odds(b), 1e-4, 1 - 1e-4); e.markets++;
  }
  const top = Object.values(byEvent).sort((a, b) => b.stake - a.stake)[0];
  const stake = top.stake;
  const p = clip(top.stake > 0 ? top.wsum / top.stake : o.convictionTau, 1e-4, 1 - 1e-4);
  const payout = stake > 0 ? Math.round(stake / p) : 0;
  const fires = stake >= o.convictionUsd && p <= o.convictionTau;
  const score = fires
    ? clip(0.45 + 0.18 * Math.log10(Math.max(1, stake / o.convictionUsd)) + (o.convictionTau - p), 0, 1)
    : clip((stake / o.convictionUsd) * 0.3, 0, 0.39);
  const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const where = top.markets > 1 ? (usd(stake) + " across " + top.markets + " markets of one event") : ("a single " + usd(stake) + " bet");
  return {
    key: "conviction", hasData: true, score, fires,
    stake, entryPrice: +p.toFixed(4), payout, market: top.market || "", markets: top.markets,
    explain: fires
      ? where + " at ~" + Math.round(p * 100) + "% that paid ~" + usd(payout) +
        " — a high-conviction long-shot concentrated on one outcome, the single-event insider signature (the binomial needs ≥5 independent events; this is the confluence path)."
      : "Largest concentrated long-shot position " + usd(stake) + " at ~" + Math.round(p * 100) + "% — below the high-conviction threshold (" + usd(o.convictionUsd) + ").",
  };
}

/* ============================================================================
 *  6b. INFORMED ENTRY TIMING — the "bought cheap, late, just before the surprise"
 *  signature shared by every confirmed case (Van Dyke: night before; Iran ring:
 *  hours before at ~10c). For a wallet's WON deep-long-shots with known entry +
 *  resolution times, measure how long BEFORE resolution they bought. Entering a
 *  ≤τ-implied winner within a tight window of the outcome is hard to explain
 *  without knowing it was coming. Excluded (hasData=false) when timestamps are
 *  missing, so it never penalises wallets we simply lack timing for. */
function timing(bets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const odds = (b) => (isNum(b.entryPrice) ? b.entryPrice : b.impliedProb);
  const cand = (bets || []).filter((b) => b && b.won === true && isNum(odds(b)) && odds(b) <= o.timingTau
    && isNum(b.ts) && b.ts > 0 && isNum(b.resolvedMs) && b.resolvedMs > 0 && b.resolvedMs / 1000 > b.ts);
  if (!cand.length) return { key: "timing", hasData: false };
  const hrs = cand.map((b) => (b.resolvedMs / 1000 - b.ts) / 3600);
  const late = hrs.filter((h) => h <= o.timingWindowH).length;
  const minH = Math.min.apply(null, hrs);
  const sorted = hrs.slice().sort((a, b) => a - b);
  const medianH = sorted[Math.floor(sorted.length / 2)];
  const fires = late >= 1 && minH <= o.timingWindowH;
  const score = fires
    ? clip(0.42 + 0.08 * Math.min(4, late) + (o.timingWindowH - minH) / o.timingWindowH * 0.3, 0, 1)
    : clip(late * 0.18, 0, 0.39);
  const fmtH = (h) => (h < 48 ? Math.round(h) + "h" : Math.round(h / 24) + "d");
  return {
    key: "timing", hasData: true, fires, score,
    lateWins: late, n: cand.length, minHours: +minH.toFixed(1), medianHours: +medianH.toFixed(1),
    explain: fires
      ? late + " of " + cand.length + " winning long-shots were bought within " + o.timingWindowH + "h of resolution (soonest " + fmtH(minH) +
        " before) — entering a ~" + Math.round((cand[hrs.indexOf(minH)] ? odds(cand[hrs.indexOf(minH)]) : 0.1) * 100) + "% outcome right before it happened is the informed-entry signature."
      : "Winning long-shots were entered " + fmtH(medianH) + " before resolution on average — not an unusually late, informed entry.",
  };
}

/* ============================================================================
 *  9. CONCENTRATION — directional + event purity (the "all-YES, one-cluster" tell).
 *  Van Dyke was 100% YES, 13/13, every dollar on the Venezuela cluster. purity =
 *  max(yes,no stake)/total; clusterDensity = top-event stake / total. Fires only
 *  with real money behind it (>= concMinUsd) and >= concMinBets, so it stays inert
 *  on the lone-bet conviction archetype (can't collude with `conviction`). Common
 *  alone among long-shot bettors → LOW weight, only matters in >=2-agreeing confluence.
 *  bets: [{ stakeUsd, outcome ('YES'|'NO'), eventGroup?, cond?, question? }]. */
function concentration(bets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const rs = (bets || []).filter((b) => b && isNum(Number(b.stakeUsd)) && Number(b.stakeUsd) > 0 && b.outcome != null);
  if (rs.length < o.concMinBets) return { key: "concentration", hasData: false };
  let yes = 0, no = 0, total = 0; const byEvent = {};
  for (const b of rs) {
    const s = Number(b.stakeUsd); total += s;
    const side = String(b.outcome).toUpperCase();
    if (side === "YES") yes += s; else if (side === "NO") no += s;
    const ev = b.eventGroup || b.cond || b.question || "?";
    byEvent[ev] = (byEvent[ev] || 0) + s;
  }
  if (total <= 0) return { key: "concentration", hasData: false };
  const dirPurity = Math.max(yes, no) / total;
  const clusterDensity = Object.values(byEvent).reduce((m, s) => Math.max(m, s), 0) / total;
  const fires = dirPurity >= o.concDirTau && total >= o.concMinUsd;
  const score = fires
    ? clip(0.46 + (dirPurity - o.concDirTau) / (1 - o.concDirTau) * 0.3 + (clusterDensity - 0.5) * 0.2, 0, 1)
    : clip((dirPurity - 0.5) * 0.6, 0, 0.39);
  const dir = yes >= no ? "YES" : "NO";
  const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
  return {
    key: "concentration", hasData: true, fires, score,
    dirPurity: +dirPurity.toFixed(3), clusterDensity: +clusterDensity.toFixed(3), totalStake: Math.round(total), nBets: rs.length, dominantSide: dir,
    explain: fires
      ? Math.round(dirPurity * 100) + "% of " + usd(total) + " staked one direction (" + dir + "), " + Math.round(clusterDensity * 100) +
        "% in a single event cluster — the un-hedged, single-thesis concentration of someone betting what they already know."
      : Math.round(dirPurity * 100) + "% single-direction across " + usd(total) + " — not concentrated enough (or below the " + usd(o.concMinUsd) + " floor) to flag.",
  };
}

/* ============================================================================
 * 10. SIZING — within-trader bet-size anomaly (Harvard "within-trader bet size").
 *  The informed bet dwarfs the wallet's own norm: top EVENT position vs the
 *  wallet's MEDIAN bet. Fires if >= sizingMult× median AND >= sizingFloorUsd. Needs
 *  >= sizingMinBets (a real distribution), so a lone-bet wallet → hasData=false and
 *  it can NEVER stand in as the second agreeing detector for a single-bet conviction
 *  case. For multi-bet wallets it's independent of `conviction` (relative, not absolute).
 *  bets: [{ stakeUsd, eventGroup?, cond?, question? }]. */
function sizing(bets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const stakes = (bets || []).map((b) => Number(b && b.stakeUsd)).filter((s) => isNum(s) && s > 0);
  if (stakes.length < o.sizingMinBets) return { key: "sizing", hasData: false };
  const byEvent = {};
  for (const b of bets) {
    const s = Number(b.stakeUsd); if (!(isNum(s) && s > 0)) continue;
    const ev = b.eventGroup || b.cond || b.question || "?";
    byEvent[ev] = (byEvent[ev] || 0) + s;
  }
  const maxEvent = Math.max.apply(null, Object.values(byEvent));
  const sorted = stakes.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const ratio = median > 0 ? maxEvent / median : 0;
  const fires = ratio >= o.sizingMult && maxEvent >= o.sizingFloorUsd;
  const score = fires
    ? clip(0.46 + 0.14 * Math.log10(Math.max(1, ratio / o.sizingMult)) + Math.min(0.2, maxEvent / o.sizingFloorUsd * 0.02), 0, 1)
    : clip((ratio / o.sizingMult) * 0.3, 0, 0.39);
  const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
  return {
    key: "sizing", hasData: true, fires, score,
    maxEventStake: Math.round(maxEvent), medianStake: Math.round(median), ratio: +ratio.toFixed(1), nBets: stakes.length,
    explain: fires
      ? "Largest position " + usd(maxEvent) + " is ~" + Math.round(ratio) + "× this wallet's median bet (" + usd(median) +
        ") — an informed bet that dwarfs its own trading norm (the within-trader size anomaly)."
      : "Largest position " + usd(maxEvent) + " vs a " + usd(median) + " median (" + ratio.toFixed(1) + "×) — within this wallet's normal sizing.",
  };
}

/* ============================================================================
 *  7. CLUSTER — pairwise linkage + cluster build (Meiklejohn-style).
 *  link(a,b) = w1·shared_funder + w2·co_spend + w3·sync_entry + w4·create_prox,
 *  each signal in [0,1]. cluster if mean pairwise link >= τ (0.80). */
function clusterLink(signals, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const w = o.clusterW;
  const s = signals || {};
  const v = [s.sharedFunder, s.coSpend, s.syncEntry, s.createProx].map((x) => clip(isNum(x) ? x : 0, 0, 1));
  const link = clip(w[0] * v[0] + w[1] * v[1] + w[2] * v[2] + w[3] * v[3], 0, 1);
  return +link.toFixed(3);
}
// edges: [{ from, to, link }]. Returns mean pairwise link + whether it's a cluster.
function clusterScore(edges, nWallets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const es = (edges || []).filter((e) => e && isNum(e.link));
  if (!es.length || !(nWallets >= 2)) return { key: "cluster", hasData: false };
  const mean = es.reduce((a, e) => a + e.link, 0) / es.length;
  const isCluster = mean >= o.clusterTau;
  return { key: "cluster", hasData: true, score: clip((mean - 0.5) / 0.5, 0, 1),
    meanLink: +mean.toFixed(3), nWallets, nEdges: es.length, isCluster,
    explain: nWallets + " wallets, mean pairwise link " + mean.toFixed(2) +
      (isCluster ? " ≥ 0.80 — treated as one entity (probable common ownership, not confirmed)." : " (below the 0.80 cluster threshold).") };
}

/* ============================================================================
 *  FUSION -> tier. Combine FIRED detectors with the artifact contribution
 *  weights (won 34, cluster 24, conceal 16, longshot 12, fresh 8, held 6),
 *  renormalised over fired only. The TIER is gated: Extreme/High require the
 *  binomial threshold AND >= 2 independent detectors agreeing.
 *    dets: { won, longshot, held, fresh, baseline, conceal, cluster } (any subset) */
function fuse(dets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  dets = dets || {};
  const w = o.contribW;
  // "fired" = detector ran (hasData) and its own `fires`/cluster/threshold is true
  const firedKeys = [];
  for (const key of Object.keys(w)) {
    const d = dets[key];
    if (!d || !d.hasData) continue;
    const fires = key === "won" ? (d.P != null && d.P <= o.pNotable)
      : key === "cluster" ? !!d.isCluster
      : !!d.fires;
    if (fires) firedKeys.push(key);
  }
  const contributions = {};
  const wsum = firedKeys.reduce((a, k) => a + w[k], 0) || 1;
  firedKeys.forEach((k) => { contributions[k] = Math.round((w[k] / wsum) * 100); });

  const P = dets.won && dets.won.hasData ? dets.won.P : null;
  const agreeing = firedKeys.filter((k) => {
    const d = dets[k]; return isNum(d.score) ? d.score >= o.agreeSub : true;
  }).length;
  const convFires = !!(dets.conviction && dets.conviction.hasData && dets.conviction.fires);

  // Two paths to a flag:
  //  (1) the RECORD path — binomial improbability over >=5 bets (→ up to Extreme).
  //  (2) the SINGLE-BET path — a lone high-conviction long-shot win CORROBORATED
  //      by >=2 agreeing detectors (fresh/conceal/held/cluster/category). A single
  //      bet can't be statistically "extreme", so this path caps at High — it's
  //      the confluence, not the math, that flags it. This is what catches the
  //      one-shot insider (Van Dyke / Maduro) the binomial cannot see.
  let tier = "unflagged";
  if (P != null && agreeing >= o.minAgree && P <= o.pExtreme) tier = "extreme";
  else if (P != null && agreeing >= o.minAgree && P <= o.pHigh) tier = "high";
  else if (convFires && agreeing >= o.minAgree) tier = "high";
  else if (firedKeys.length && (P == null || P <= o.pNotable)) tier = "notable";

  return {
    tier, fired: firedKeys, contributions, agreeing, convictionPath: convFires && tier === "high" && (P == null || P > o.pHigh),
    P, improbDenom: dets.won && dets.won.improbDenom, improbText: dets.won && dets.won.improbText,
    full: firedKeys.length >= 3,
  };
}

/* ============================================================================
 *  HARVARD composite informed-trading score (Ofir & Ofir, "Informed Trading on
 *  Prediction Markets", March 2026). The unit is a (wallet, MARKET) EPISODE — a
 *  single bet in a single market — NOT the wallet's whole record. This is the key
 *  difference from the binomial path: it flags one outsized, profitable, late,
 *  directional bet regardless of the wallet's broader history.
 *
 *    S = 25·z_bet_cross + 20·z_bet_within + 30·z_profit_cross
 *        + 15·(late_buy_fraction·100) + 10·(directional_score·100)
 *
 *  where (all supplied by the scanner from per-market cross-sections):
 *    z_bet_cross   = (wallet's buy $ − market mean) / market SD   (vs peers in that market)
 *    z_bet_within  = (this bet − wallet's own mean) / wallet SD    (vs the wallet's own norm)
 *    z_profit_cross= (wallet's profit − market mean) / market SD   (vs peers in that market)
 *    late_buy_fraction = share of buy volume in the final 48h before resolution  [0..1]
 *    directional_score = one-sidedness (1 = pure buy, held to resolution)         [0..1]
 *
 *  RETENTION (Harvard's inclusion gate): keep only episodes where z_bet_cross > 2
 *  OR z_bet_within > 2 (~top 2.5% by bet size). The scanner also applies Harvard's
 *  market filters ($10k+ market volume, ≥3 buyers, ≥$500 wallet buy) upstream.
 * ========================================================================== */
const HARVARD_W = { betCross: 25, betWithin: 20, profitCross: 30, late: 15, dir: 10 };
function harvardEpisode(e, opts) {
  if (!e) return { key: "harvard", hasData: false };
  // The cross-sectional bet z (z_bet_cross) is the spine of the composite and its retention
  // gate; if it was UNMEASURABLE (market stake dispersion sd=0 → null), there is no honest
  // Harvard score to give — degrade to no-data rather than scoring a fabricated 0.
  if (!isNum(e.zBetCross)) return { key: "harvard", hasData: false };
  const zbc = e.zBetCross;
  const zbw = isNum(e.zBetWithin) ? e.zBetWithin : 0;
  const zpc = isNum(e.zProfitCross) ? e.zProfitCross : 0;
  const late = clip(isNum(e.lateBuyFraction) ? e.lateBuyFraction : 0, 0, 1);
  const dir = clip(isNum(e.directionalScore) ? e.directionalScore : 0, 0, 1);
  const S = HARVARD_W.betCross * zbc + HARVARD_W.betWithin * zbw + HARVARD_W.profitCross * zpc +
            HARVARD_W.late * (late * 100) + HARVARD_W.dir * (dir * 100);
  const retained = zbc > 2 || zbw > 2;   // Harvard top-2.5%-by-bet-size inclusion gate
  return {
    key: "harvard", hasData: true, S: +S.toFixed(1), retained,
    zBetCross: +zbc.toFixed(2), zBetWithin: +zbw.toFixed(2), zProfitCross: +zpc.toFixed(2),
    lateBuyFraction: +late.toFixed(3), directionalScore: +dir.toFixed(3),
  };
}
// Tier from Harvard's composite S. Calibrated to the paper's flagged distribution
// (S ranges 40–3987, mean 120.3, median 105.3): notable ≈ median, high ≈ 2×, extreme far out.
const HARVARD_TIERS = { notable: 90, high: 220, extreme: 600 };
function harvardTier(S, opts) {
  const t = Object.assign({}, HARVARD_TIERS, opts && opts.harvardTiers);
  if (!(S > 0)) return null;
  if (S >= t.extreme) return "extreme";
  if (S >= t.high) return "high";
  if (S >= t.notable) return "notable";
  return null;
}

module.exports = {
  DEFAULTS, isNum, clip, lgamma, logChoose, binomTailGE, improbDenom, improbText,
  decorrelate, won, longshot, held, fresh, baseline, concealment, conviction, timing,
  concentration, sizing, clusterLink, clusterScore, fuse, winBaseline, categoryRisk,
  harvardEpisode, harvardTier, HARVARD_W, HARVARD_TIERS,
};
