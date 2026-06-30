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
  // repeat-offender: a "surprising" win is one entered at ≤ this implied prob (against the odds).
  repeatSurpriseTau: 0.5,
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
  // CROSS-SECTIONAL PROFIT (Harvard z_profit_cross, their highest-weighted signal): did the
  // wallet profit MORE than the other traders in the SAME market? Fires when its best episode's
  // profit z-score exceeds this. This is what catches FAVORITE-betting insiders the long-shot
  // binomial is structurally blind to.
  profitCrossTau: 2,
  // fusion contribution weights. Re-balanced for the cross-sectional era: accuracy is split
  // across `won` (per-wallet improbable record) + `profitCross` (out-earned market peers) so it
  // isn't double-counted; our on-chain moat (cluster/fresh) Harvard lacks is preserved; the weak
  // descriptive signals (longshot/held) are trimmed. Provisional — the validation job re-sets
  // these from each detector's MEASURED correlation with winning.
  // REALIGNED to measured predictive power (per-detector win-rate validation) + signal TYPE.
  // DISPLAY-ONLY: these set the "% of flag" breakdown, NOT the flag decision (that's the binomial
  // P-value + ≥2 agreement). won (binomial) measured the strongest predictor (+19.5) → highest.
  // The on-chain structural signals Harvard lacks — cluster (common ownership), concealment,
  // fresh (purpose-built) — and concentration (measured +10.7, was under-weighted) are elevated.
  // The bet-mechanics signals — sizing, conviction, profitCross — measured negative/noisy lift and
  // are trimmed (profitCross was 26 with a −15 measured lift; it's a corroborator, not a predictor).
  // REWEIGHTED per the 7-case ground truth: pre-event TIMING is the #1 signal across every
  // confirmed case, so now that it is EVENT-ANCHORED (price-shock, not resolution) it is weighted
  // heavily (8 → 18). crossCat (near-perfect cross-category record) and repeat (early-and-right on
  // multiple separate events) are added as first-class diagnostic signals. profit/bet-size signals
  // (profitCross/sizing) are trimmed — being RIGHT and EARLY is more diagnostic than betting big.
  // NOTE: `fresh` trimmed 10 → 5. A live scan showed it fires on ~75% of wallets — Polymarket
  // provisions a NEW PROXY WALLET PER USER at first deposit, so almost every account is "fresh"
  // (new wallet, no prior tx). It is a near-constant here, not a purpose-built-wallet tell, so it
  // gets a low display weight and is excluded from the favorite-path anti-whale gate (see build.js).
  // newsBlackout (12) is a TIMING-dimension corroborator — a direct "traded ahead of public info"
  // proxy — weighted alongside conceal/concentration, never above timing(18) itself. fedRegister (6)
  // is the noisiest signal (regulatory-doc matching), so it gets a deliberately LOW corroborator
  // weight and can never carry a flag alone.
  contribW: { won: 26, crossCat: 22, timing: 18, cluster: 18, newsBlackout: 12, concentration: 12, conceal: 12, repeat: 10, conviction: 6, fedRegister: 6, fresh: 5, sizing: 5, profitCross: 5, longshot: 4, held: 4, baseline: 4 },
  newsWindowH: 24,            // pre-entry window for the news-blackout query (hours)
  newsBlackoutFloor: 0,       // ≤ this many matching articles in the window = a blackout
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

// Upper-tail of the standard normal, P(Z >= z), via the Abramowitz-Stegun 7.1.26
// erfc approximation (|err| < 1.5e-7). Used to turn a cross-sectional z-score into an
// honest "this would happen ~1 in N times by chance IF peer profits were normal" denom.
function normalUpperTail(z) {
  if (!isNum(z)) return null;
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  const erf = x >= 0 ? y : -y;            // erf is odd
  const erfc = 1 - erf;
  return clip(0.5 * erfc, 0, 1);          // = P(Z >= z)
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
 *  CORRELATION KEY — the underlying event a bet really tracks, so date-ladder and
 *  re-phrased variants of ONE event collapse together. The per-market event slug is
 *  too fine: "US strikes Iran by Feb 28 / Mar 1 / Mar 2 / next strike on Feb 23 /
 *  military action against Iran by Sunday" are ALL one bet — will the US attack Iran —
 *  that resolve together, but each has its own slug. Winning 20 of them is ONE correct
 *  call, not 20 independent long-shot wins; counting them independently massively
 *  inflates the binomial. We key on the market's salient ENTITIES (extractEntities) plus
 *  a coarse action class (military / regime-change / ceasefire / election), so those
 *  variants share a key and de-correlate to a single effective event. */
const ACT_MIL = /strik|attack|militar|\bwar\b|engage|bomb|invad|missile|nuclear|troop|forces|\bhit\b/;
const ACT_REG = /\bout\b|leave|leav|\bfall\b|falls|resign|oust|removed|remove|step ?down|\bexit\b|impeach|overthrow/;
const ACT_PEACE = /ceasefire|cease-fire|\bpeace\b|truce|\bdeal\b|agreement/;
const ACT_ELEC = /\bwin\b|\bwins\b|elect|nominee|preside|primary/;
function corrKeyOf(question) {
  if (!question || typeof question !== "string") return null;
  const ents = extractEntities(question);
  if (!ents.length) return null;
  const top = ents.slice(0, 2).map((e) => e.toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean).sort();
  if (!top.length) return null;
  const s = question.toLowerCase();
  const act = ACT_MIL.test(s) ? "mil" : ACT_REG.test(s) ? "reg" : ACT_PEACE.test(s) ? "peace" : ACT_ELEC.test(s) ? "elec" : "x";
  return top.join("-") + "|" + act;
}
// The grouping key for de-correlation: an explicit corrKey wins, else derive it from the
// question, else fall back to the event slug, else treat the bet as its own singleton event.
function betGroupKey(b, idx) {
  if (b && b.corrKey != null) return "c:" + b.corrKey;
  const ck = corrKeyOf(b && (b.question || b.market));
  if (ck) return "c:" + ck;
  if (b && b.eventGroup != null) return "g:" + b.eventGroup;
  return "s:" + idx;
}

/* ============================================================================
 *  DE-CORRELATION — collapse bets on the SAME underlying outcome.
 *  Many bets on one event (correlated) would inflate the binomial. We collapse
 *  each correlation group to ONE effective bet: won = did they (net) win that event,
 *  p = mean implied across the group. Bets with no group are singletons.
 *  Returns { n, k, p, collapsed } over independent effective bets. */
function decorrelate(bets) {
  const groups = new Map();
  for (let idx = 0; idx < bets.length; idx++) {
    const b = bets[idx];
    const key = betGroupKey(b, idx);
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

/* 1b. CROSS-CATEGORY ACCURACY — improbability over the FULL resolved record at ANY odds.
 *  The binomial `won` is long-shot-only (≤35%), so it is structurally BLIND to the serial winner
 *  who is near-perfect across DIVERSE markets at MODERATE odds (AlphaRaccoon 22/23, ricosuave 7/7).
 *  Here each de-correlated event keeps its OWN entry odds, so the test is a Poisson-binomial (sum of
 *  Bernoullis with different p). We use the exact mean μ=Σpᵢ and variance σ²=Σpᵢ(1−pᵢ) with a normal
 *  (Lyapunov) tail — honest for mixed odds where a single-p binomial would be wrong. Fires when the
 *  realised wins sit far above what the blended odds predict. bets: [{impliedProb|entryPrice, won, eventGroup?}]. */
function crossCat(bets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!Array.isArray(bets)) return { key: "crossCat", hasData: false };
  const resolved = bets
    .map((b) => ({ impliedProb: isNum(b.impliedProb) ? b.impliedProb : (isNum(b.entryPrice) ? b.entryPrice : null), won: b.won, eventGroup: b.eventGroup, corrKey: b.corrKey, question: b.question }))
    .filter((b) => isNum(b.impliedProb) && typeof b.won === "boolean");
  if (resolved.length < o.minBets) return { key: "crossCat", hasData: false, reason: "fewer than " + o.minBets + " resolved bets" };
  // de-correlate to independent events (same collapse as the binomial), keeping each event's odds.
  const groups = new Map();
  resolved.forEach((b, idx) => {
    const key = betGroupKey(b, idx);
    const g = groups.get(key) || { ps: [], wins: 0, n: 0 };
    g.ps.push(clip(b.impliedProb, 1e-6, 1 - 1e-6)); g.n++; if (b.won) g.wins++;
    groups.set(key, g);
  });
  let n = 0, k = 0, mu = 0, varSum = 0; const pbar = [];
  for (const g of groups.values()) {
    const p = clip(g.ps.reduce((a, b) => a + b, 0) / g.ps.length, 1e-6, 1 - 1e-6);
    n += 1; if (g.wins * 2 >= g.n) k += 1; mu += p; varSum += p * (1 - p); pbar.push(p);
  }
  if (n < o.minBets || !(varSum > 0)) return { key: "crossCat", hasData: false };
  const meanImplied = mu / n;
  // a record concentrated in long-shots is already the binomial `won`'s job — crossCat is for the
  // MODERATE-odds serial winner, so it adds nothing (and shouldn't double-count) when the blended
  // odds are themselves long-shot. Require a non-long-shot blended book to have DATA here.
  if (meanImplied <= 0.35) return { key: "crossCat", hasData: false, reason: "blended odds are long-shot — covered by the binomial" };
  const z = (k - mu) / Math.sqrt(varSum);
  const P = z > 0 ? normalUpperTail(z) : 1;                    // one-sided: far MORE wins than predicted
  const denom = improbDenom(P);
  const score = clip((z - 2) / 4, 0, 1) * (z >= 3 ? 1 : 0.6);  // ramps in over z∈[2,6]; muted below z=3
  const fires = z >= 3;                                         // ~1-in-740; a near-perfect cross-category record
  return {
    key: "crossCat", hasData: true, fires, score: fires ? clip(0.45 + score * 0.55, 0, 1) : clip(score * 0.4, 0, 0.4),
    n, k, expectedWins: +mu.toFixed(2), z: +z.toFixed(2), P, improbDenom: denom, improbText: improbText(denom),
    meanImplied: +(meanImplied * 100).toFixed(0), winRate: +(100 * k / n).toFixed(1),
    explain: "Won " + k + " of " + n + " bets across markets the blended odds priced at ~" + Math.round(meanImplied * 100) +
      "% — about " + mu.toFixed(1) + " expected by luck (" + z.toFixed(1) + "σ above chance, ≈ " + improbText(denom) +
      "). A near-perfect record across diverse, moderate-odds markets the long-shot test can't see.",
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

/* 4. FRESH — wallet age + funding recency. Fires if age <= 14d AND prior_tx = 0.
 *  LIMITATION (Polymarket): this is a WEAK signal here. Polymarket gives each user a fresh PROXY
 *  wallet at first deposit, so ~75% of accounts trip this (new wallet, no prior tx, funded just
 *  before the first bet) — it is NOT the purpose-built-wallet tell it is on a normal EOA. Kept for
 *  context + a low contribution weight, but it does NOT gate the favorite path and barely moves the
 *  composite. A meaningful "purpose-built" signal here would need the funding SOURCE + single-market
 *  focus, not just wallet age. */
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

/* 5. BASELINE — realized win rate vs the payoff-aware BREAK-EVEN rate. */
function baseline(x) {
  if (!x || !isNum(x.winRate)) return { key: "baseline", hasData: false };
  const base = winBaseline(x.category);
  const wr = x.winRate > 1 ? x.winRate / 100 : x.winRate;       // accept 94 or 0.94
  // BREAK-EVEN benchmark (payoff-aware): in a fair market you must win at your AVERAGE ENTRY
  // PRICE just to break even (buy at $0.16 → need a 16% win rate; buy at $0.80 → need 80%). This
  // captures the 4:1 risk/reward asymmetry automatically. We compare win rate to break-even, NOT
  // to a flat 50% — a "55% win rate" wallet that bought favorites is actually LOSING money.
  const be = isNum(x.breakEven) ? (x.breakEven > 1 ? x.breakEven / 100 : x.breakEven) : base;
  const ratio = be > 0 ? wr / be : 0;
  const lift = +(wr - be).toFixed(3);
  return { key: "baseline", hasData: true, score: clip((ratio - 1) / 4, 0, 1), fires: lift > 0.05,
    winRate: +(wr * 100).toFixed(1), baseline: +(base * 100).toFixed(0), breakEven: +(be * 100).toFixed(0), categoryRisk: categoryRisk(x.category),
    explain: "Won " + Math.round(wr * 100) + "% — break-even at these entry prices is ~" + Math.round(be * 100) + "% (you must win at your average buy price just to not lose money). " +
      (lift > 0 ? "+" + Math.round(lift * 100) + " points above break-even." : "at or below break-even.") };
}

/* 5b. CROSS-SECTIONAL PROFIT (Harvard z_profit_cross — their highest-weighted signal). The
 *  wallet's single best episode where it profited FAR more than the other traders in the SAME
 *  market. Works at ANY odds (incl. favorites), so it catches the big winning-favorite insider
 *  the ≤35% long-shot binomial is structurally blind to. Each bet may carry b.hz.zProfitCross,
 *  the per-market cross-section the scanner already computes. */
function profitCross(bets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!Array.isArray(bets)) return { key: "profitCross", hasData: false };
  let best = null;
  for (const b of bets) {
    const z = b && b.hz && isNum(b.hz.zProfitCross) ? b.hz.zProfitCross : null;
    if (z == null) continue;
    if (!best || z > best.z) best = { z, bet: b };
  }
  if (!best) return { key: "profitCross", hasData: false };
  const fires = best.z >= o.profitCrossTau;
  const raw = clip(best.z / 8, 0, 1);                            // ramps to 1 by z≈8 (extreme outliers)
  const b = best.bet || {};
  // NOTE: we deliberately do NOT convert this z into a "1-in-N chance of luck". Trader-profit
  // distributions in a market are heavy-tailed, NOT normal, so a normal-tail probability for a z
  // of 8+ yields a fabricated astronomical figure. profitCross is a relative-rank CORROBORATING
  // signal (how far above peers), not a standalone improbability — report only the z.
  return { key: "profitCross", hasData: true, score: fires ? clip(0.45 + raw * 0.55, 0, 1) : clip(raw * 0.4, 0, 0.4),
    z: +best.z.toFixed(2), fires, won: !!b.won,
    market: b.question || null, cond: b.cond || null, url: b.url || null, tx: b.tx || null, ts: b.ts || null,
    stakeUsd: isNum(b.stakeUsd) ? b.stakeUsd : null, entryPrice: isNum(b.entryPrice) ? b.entryPrice : null,
    explain: "Profited " + best.z.toFixed(1) + " standard deviations more than the other traders in the same market" +
      (fires ? " — a cross-sectional profit outlier; here it only corroborates a wallet already flagged by the statistical record." : ".") };
}

/* 6. CONCEAL — concealment signatures. Fires only if >= 2 tactics co-occur. */
function concealment(x, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!x) return { key: "conceal", hasData: false };
  const splitRatio = isNum(x.splitRatio) ? x.splitRatio : null;       // one bet spread across linked wallets
  const decoyRatio = isNum(x.decoyRatio) ? x.decoyRatio : null;       // tiny decoy bets / real bets
  const cashoutH = isNum(x.cashoutLatencyHours) ? x.cashoutLatencyHours : null; // resolution -> off-platform
  // RENAME / DELETION proxy (ricosuave deleted, AlphaRaccoon renamed, Van Dyke deletion request): a
  // wallet with a substantial winning on-chain history but NO public display name is consistent with
  // an account scrubbed/anonymised after the fact. A weak, honest proxy — we can't see prior names,
  // only that an account with real activity is now nameless. anonymized=true only when both hold.
  const anonymized = x.anonymized === true;
  if (splitRatio == null && decoyRatio == null && cashoutH == null && !anonymized) return { key: "conceal", hasData: false };
  const tactics = [];
  if (splitRatio != null && splitRatio >= o.splitTau) tactics.push("stake-splitting across linked wallets");
  if (decoyRatio != null && decoyRatio >= o.decoyTau) tactics.push("decoy small bets");
  if (cashoutH != null && cashoutH <= o.cashoutFastHours) tactics.push("rapid off-platform cash-out");
  if (anonymized) tactics.push("no public profile despite a substantial winning history (possible rename/deletion)");
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
 *  6b. INFORMED ENTRY TIMING — the "bought cheap, just before the surprise" signature, the #1
 *  ground-truth signal across all confirmed cases (Magamyman 71 min before the news, Maduro hours
 *  before, Nobel 5–11h, Taylor 22h). EVENT-ANCHORED: the right reference point is when the INFO
 *  HIT — the market's price-shock (when it repriced) — NOT the official resolution, which can lag
 *  the news by days. We measure how long BEFORE the shock the wallet bought. Anchor preference:
 *    b.shockTs (price-repricing time, from the market trade series)  →  b.eventTs  →  resolvedMs.
 *  Entering a winner right before its price-shock is the informed-entry tell. hasData=false when no
 *  anchor/timestamp exists, so wallets we simply lack timing for are never penalised.
 *  NOTE (honesty): shockTs is derived from a TRUNCATED trade sample, so the anchor is approximate;
 *  it still beats resolution-anchoring, which is wrong whenever resolution lags the event. */
function timing(bets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const odds = (b) => (isNum(b.entryPrice) ? b.entryPrice : b.impliedProb);
  // event anchor in SECONDS — the price-shock if known, else event time, else resolution.
  const anchorSec = (b) => (isNum(b.shockTs) && b.shockTs > 0 ? b.shockTs
    : isNum(b.eventTs) && b.eventTs > 0 ? b.eventTs
    : isNum(b.resolvedMs) && b.resolvedMs > 0 ? b.resolvedMs / 1000 : null);
  const anchored = (bets || []).some((b) => b && (isNum(b.shockTs) || isNum(b.eventTs)));   // any true event anchor present?
  const cand = (bets || []).filter((b) => {
    const a = anchorSec(b);
    return b && b.won === true && isNum(odds(b)) && odds(b) <= o.timingTau && isNum(b.ts) && b.ts > 0 && a != null && a > b.ts;
  });
  if (!cand.length) return { key: "timing", hasData: false };
  const hrs = cand.map((b) => (anchorSec(b) - b.ts) / 3600);
  const late = hrs.filter((h) => h <= o.timingWindowH).length;
  const minH = Math.min.apply(null, hrs);
  const sorted = hrs.slice().sort((a, b) => a - b);
  const medianH = sorted[Math.floor(sorted.length / 2)];
  const fires = late >= 1 && minH <= o.timingWindowH;
  const score = fires
    ? clip(0.42 + 0.08 * Math.min(4, late) + (o.timingWindowH - minH) / o.timingWindowH * 0.3, 0, 1)
    : clip(late * 0.18, 0, 0.39);
  const fmtH = (h) => (h < 48 ? Math.round(h) + "h" : Math.round(h / 24) + "d");
  const ref = anchored ? "the price-shock" : "resolution";
  return {
    key: "timing", hasData: true, fires, score, anchored,
    lateWins: late, n: cand.length, minHours: +minH.toFixed(1), medianHours: +medianH.toFixed(1),
    explain: fires
      ? late + " of " + cand.length + " winning long-shots were bought within " + o.timingWindowH + "h of " + ref + " (soonest " + fmtH(minH) +
        " before) — entering a ~" + Math.round((cand[hrs.indexOf(minH)] ? odds(cand[hrs.indexOf(minH)]) : 0.1) * 100) + "% outcome right before " + (anchored ? "it repriced" : "it resolved") + " is the informed-entry signature."
      : "Winning long-shots were entered " + fmtH(medianH) + " before " + ref + " on average — not an unusually late, informed entry.",
  };
}

/* ============================================================================
 *  6c. REPEAT-OFFENDER ACROSS EVENTS — the same wallet hitting MULTIPLE separate surprising events
 *  over time (AlphaRaccoon: Gemini 3.0 + Year-in-Search; the OpenAI cluster: browser + GPT-5.2).
 *  One lucky surprise is luck; being early-and-right on several UNRELATED events is a pattern. We
 *  count DISTINCT event groups in which the wallet won a SURPRISING bet (won at ≤ surpriseTau odds).
 *  Fires at ≥2 distinct surprising events. Over the wallet's own record — no extra data needed.
 *  bets: [{ entryPrice|impliedProb, won, eventGroup?, cond?, question?, ts? }]. */
function repeat(bets, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  const odds = (b) => (isNum(b.entryPrice) ? b.entryPrice : b.impliedProb);
  const surpriseTau = isNum(o.repeatSurpriseTau) ? o.repeatSurpriseTau : 0.5;   // "against the odds" = won at ≤50%
  const events = new Map();                                    // correlation group -> { won surprising? , when }
  for (let i = 0; i < (bets || []).length; i++) {
    const b = bets[i];
    if (!b || b.won !== true || !isNum(odds(b)) || odds(b) > surpriseTau) continue;
    // count DISTINCT underlying events (same correlation key as the binomial) — so a date-ladder
    // of one event ("US strikes Iran by Feb 28 / Mar 1 / …") counts ONCE, not as many "repeats".
    const ev = betGroupKey(b, i);
    const cur = events.get(ev) || { ts: b.ts || 0, odds: odds(b) };
    if ((b.ts || 0) < cur.ts || !cur.ts) cur.ts = b.ts || cur.ts;
    cur.odds = Math.min(cur.odds, odds(b));
    events.set(ev, cur);
  }
  const nEvents = events.size;
  if (nEvents < 1) return { key: "repeat", hasData: false };
  const fires = nEvents >= 2;
  const score = fires ? clip(0.42 + 0.16 * Math.min(4, nEvents - 1), 0, 1) : clip(0.2 * nEvents, 0, 0.39);
  return {
    key: "repeat", hasData: true, fires, score, nEvents,
    explain: fires
      ? "Won against the odds in " + nEvents + " separate events — being early-and-right on multiple unrelated surprises is a repeat-offender pattern, not one lucky hit."
      : nEvents + " surprising win — not yet a repeat pattern across separate events.",
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
 *  ENTITY EXTRACTION — the accuracy crux for the news/regulatory signals. A naive scanner queries
 *  the raw market text and matches junk (the competitor matched "day moving average transit" and a
 *  fisheries doc instead of "Strait of Hormuz"). We pull SPECIFIC named entities only: runs of
 *  Title-Case words (keeping internal connectors so "Strait of Hormuz" stays intact) and ALL-CAPS
 *  acronyms (OFAC, OPEC, IMF), with generic market/finance words stop-listed out. Returns entities
 *  ranked most-specific-first (more words, then longer). An empty result means "no precise entity to
 *  query" → the news/reg detectors stay no-data rather than guessing. Pure + dependency-free. */
const ENTITY_STOP = new Set([
  "will", "the", "a", "an", "be", "by", "before", "after", "above", "below", "between", "than", "over",
  "under", "of", "and", "or", "to", "in", "on", "at", "as", "is", "are", "was", "were", "yes", "no", "not",
  "more", "less", "least", "reach", "hit", "reported", "this", "that", "these", "those", "market", "markets",
  "price", "prices", "odds", "trade", "trades", "average", "moving", "total", "count", "calls", "value",
  "level", "rate", "number", "day", "days", "week", "month", "year", "win", "wins", "won", "lose", "end",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "q1", "q2", "q3", "q4",
]);
const ENT_CONN = new Set(["of", "the", "and", "for", "de", "du", "von", "&", "-"]);
function extractEntities(question) {
  if (!question || typeof question !== "string") return [];
  const toks = question.replace(/[?,;:()"""''.]/g, " ").split(/\s+/).filter(Boolean);
  const isCap = (w) => /^[A-Z][A-Za-z0-9&/-]*$/.test(w);
  const isAcr = (w) => /^[A-Z]{2,6}$/.test(w);
  const runs = []; let cur = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    if (isCap(w)) cur.push(w);
    else if (cur.length && ENT_CONN.has(w.toLowerCase()) && i + 1 < toks.length && isCap(toks[i + 1])) cur.push(w.toLowerCase()); // keep connector inside a run
    else { if (cur.length) runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  const ents = [];
  for (const r0 of runs) {
    const r = r0.slice();
    while (r.length && (ENTITY_STOP.has(r[0].toLowerCase()) || ENT_CONN.has(r[0].toLowerCase()))) r.shift();        // trim leading stop/connector
    while (r.length && (ENTITY_STOP.has(r[r.length - 1].toLowerCase()) || ENT_CONN.has(r[r.length - 1].toLowerCase()))) r.pop(); // trim trailing
    if (!r.length) continue;
    const content = r.filter((w) => !ENTITY_STOP.has(w.toLowerCase()) && !ENT_CONN.has(w.toLowerCase()));
    if (!content.length) continue;                                  // all-generic run → not an entity
    if (content.length === 1 && !isAcr(content[0]) && content[0].length <= 3) continue;  // a lone tiny cap word is noise
    ents.push(r.join(" "));
  }
  toks.forEach((w) => { if (isAcr(w) && !ENTITY_STOP.has(w.toLowerCase())) ents.push(w); });   // standalone acronyms
  const uniq = Array.from(new Set(ents.map((s) => s.trim()))).filter((s) => s.length >= 2);
  uniq.sort((a, b) => (b.split(/\s+/).length - a.split(/\s+/).length) || (b.length - a.length)); // most words, then longest
  return uniq.slice(0, 4);
}

/* ============================================================================
 *  NEWS-BLACKOUT (information-asymmetry timing signal, GDELT). The tell isn't a big bet — it's a big
 *  CONFIDENT bet placed when the topic was QUIET in the news (they were ahead of the public, not
 *  reacting to it). Anchored on the bet's entry time: count global news articles matching the
 *  market's entity in the [t_bet − window] pre-entry window. Fires ONLY when the window is empty
 *  (a real blackout) AND the bet was OUTSIZED/informed — so it sharpens the timing dimension instead
 *  of adding noise. hasData=false when we had no precise entity to query or the fetch failed (we do
 *  not penalise markets we couldn't check). Sharper paired with the price-shock anchor: price moved
 *  + no public news beforehand = strong "traded ahead of public info".
 *    x = { articleCount (int|null), windowHours, outsized (bool), entity, hasQuery (bool) } */
function newsBlackout(x, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!x || x.hasQuery !== true || !isNum(x.articleCount)) return { key: "newsBlackout", hasData: false };
  const wh = isNum(x.windowHours) ? x.windowHours : (o.newsWindowH || 24);
  const floor = isNum(o.newsBlackoutFloor) ? o.newsBlackoutFloor : 0;       // ≤ this many articles = blackout
  const blackout = x.articleCount <= floor;
  const outsized = x.outsized === true;
  const fires = blackout && outsized;                                       // only a blackout UNDER a big informed bet
  const score = fires ? 0.6 : (blackout ? 0.3 : clip(0.2 - x.articleCount * 0.02, 0, 0.25));
  return {
    key: "newsBlackout", hasData: true, fires, score,
    articleCount: x.articleCount, windowHours: wh, entity: x.entity || null, outsized,
    explain: fires
      ? "No public news matching “" + (x.entity || "the market topic") + "” in the " + wh + "h before this outsized bet — the information-asymmetry signature: trading ahead of the public, not reacting to it."
      : blackout
        ? "News was quiet (“" + (x.entity || "topic") + "”, " + wh + "h pre-bet) but the bet wasn't outsized — not flagged on timing alone."
        : x.articleCount + " article(s) matched “" + (x.entity || "topic") + "” in the " + wh + "h before the bet — the bet may just be reacting to public news.",
  };
}

/* ============================================================================
 *  FEDERAL-REGISTER MATCH (regulatory-insider corroborator). For policy/world markets, a bet that
 *  lines up with a recent regulatory action (sanctions, agency rule) on the EXACT subject is a
 *  policy-insider tell (the Maduro/sanctions, IDF/Iran archetypes). PRECISION IS THE WHOLE POINT —
 *  a fuzzy term search false-matches (a fisheries doc to a shipping market). So this fires ONLY on
 *  matches the data layer already PRECISION-FILTERED: the market's specific entity must appear in the
 *  document's TITLE or ABSTRACT (substring), not just be a fuzzy relevance hit. Deliberately LOW
 *  weight — it corroborates, never flags alone. hasData=false without a precise entity to query.
 *    x = { matches: [{title, agency, date, url}] (already title/abstract-filtered), entity, hasQuery } */
function fedRegister(x, opts) {
  if (!x || x.hasQuery !== true || !Array.isArray(x.matches)) return { key: "fedRegister", hasData: false };
  if (!x.matches.length) return { key: "fedRegister", hasData: true, fires: false, score: 0, nDocs: 0, nAhead: 0, entity: x.entity || null, top: null,
    explain: "No recent Federal Register document matches “" + (x.entity || "this market") + "” on the title — no regulatory-insider corroboration." };
  // TIMING IS THE POINT. The regulatory-insider tell is a bet placed BEFORE the official action was
  // published — so per matched doc we compute how many days the BET preceded its publication. A doc
  // published ON/AFTER the bet (leadDays ≥ 0) means the wallet was positioned ahead of the filing; a
  // doc published BEFORE the bet means the action was already public (reacting, not ahead → not credited).
  const betSec = isNum(x.betDate) ? x.betDate : null;
  const toSec = (d) => { const t = Date.parse(String(d) + "T00:00:00Z"); return isFinite(t) ? t / 1000 : null; };
  const ann = x.matches.map((m) => { const ds = toSec(m.date); return Object.assign({}, m, { leadDays: (betSec != null && ds != null) ? Math.round((ds - betSec) / 86400) : null }); });
  const ahead = ann.filter((m) => m.leadDays != null && m.leadDays >= 0).sort((a, b) => a.leadDays - b.leadDays);  // soonest-after-bet first
  const top = ahead[0] || ann[0];
  // fire ONLY when the bet preceded a matching filing; with no bet timestamp, fall back to a plain
  // match as a weak corroborator (no temporal claim made).
  const fires = ahead.length >= 1 || betSec == null;
  const lead = top.leadDays;
  return {
    key: "fedRegister", hasData: true, fires, score: fires ? clip(0.4 + 0.06 * Math.min(3, ahead.length || 1), 0, 0.6) : 0,
    nDocs: x.matches.length, nAhead: ahead.length, entity: x.entity || null,
    top: { title: top.title || null, agency: top.agency || null, date: top.date || null, url: top.url || null, leadDays: lead },
    explain: fires
      ? (lead != null && lead >= 0
          ? "Bet placed " + lead + " day" + (lead === 1 ? "" : "s") + " BEFORE the Federal Register published “" + String(top.title || "").slice(0, 80) + "”" + (top.agency ? " (" + top.agency + ", " + top.date + ")" : "") + " — positioned ahead of the official filing on the exact subject."
          : x.matches.length + " Federal Register document(s) match “" + (x.entity || "this market") + "” around the bet — e.g. “" + String(top.title || "").slice(0, 80) + "”" + (top.agency ? " (" + top.agency + ")" : "") + ".")
      : "A matching Federal Register filing was already public before the bet — consistent with reacting to it, not trading ahead; not credited.",
  };
}

/* ============================================================================
 *  WATCHLIST (trade-time, PRE-resolution) score. The real-time complement to the resolved engine:
 *  score a single OPEN-market trade the instant it lands, with no knowledge of the outcome — so it
 *  can't use won/profit (our precision anchors), which is why it's an EARLY-WARNING signal, not
 *  proof. Mirrors our philosophy (being INFORMED/EARLY outweighs being BIG): a news-blackout under a
 *  big bet scores highest; raw size lowest. A flagged trade later HARDENS into a forensic case (if it
 *  wins and the wallet flags) or self-clears (the reconcile runs in the scanner on resolution).
 *    x = { sizeUsd, marketSizes:[usd…] (peer trades in this market), marketVolUsd? (market 24h $ vol),
 *          entryPrice (price PAID, 0–1), walletFlagged? (already a published Suspect), fresh? (first-ever
 *          trade ≈ this bet), blackout? (NO public news before the bet — the clearest "knew first" tell),
 *          anticipated? (a matching regulatory filing dropped AFTER the bet), publicInfo? (news/filing
 *          PREDATED the bet → public info, exculpatory) }
 *  PRE-RESOLUTION model: an open market hasn't resolved, so there is no won/profit/improbable-record to
 *  test — only signals observable AT PLACEMENT, each an informed-trading tell, none a proof. */
const WATCH_W = { outsized: 25, longshot: 25, blackout: 35, repeat: 30, fresh: 15, anticipated: 12, publicInfo: -20 };
const WATCH_MAX = 142;   // sum of the POSITIVE signals; publicInfo (−20) is the exculpatory reducer
function watchlistScore(x, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  x = x || {};
  // --- magnitude vs the market (ONE dimension) ---
  const sizes = (x.marketSizes || []).filter((s) => isNum(s) && s > 0);
  const nPeers = sizes.length;
  const mu = nPeers ? sizes.reduce((a, b) => a + b, 0) / nPeers : 0;
  const sd = nPeers > 1 ? Math.sqrt(sizes.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (nPeers - 1)) : 0;
  const sorted = sizes.slice().sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))] : 0;
  const z = sd > 0 ? (x.sizeUsd - mu) / sd : 0;
  const whaleX = p90 > 0 ? x.sizeUsd / p90 : 0;
  // The PRIMARY magnitude test is share of the market's 24h volume — it needs no peer sample. A global
  // recent-trades feed rarely carries ≥ watchMinPeers trades of the SAME open market, which is exactly
  // why the old peer-only test almost never fired and the score collapsed onto the news signal. The
  // peer z/whaleX test is a BONUS that fires only with ≥ watchMinPeers peers (a z over 2–3 trades is
  // noise). Raw z/whaleX/volShare are always reported as diagnostics.
  const minPeers = isNum(o.watchMinPeers) ? o.watchMinPeers : 6;
  const enoughPeers = nPeers >= minPeers;
  const vol = isNum(x.marketVolUsd) && x.marketVolUsd > 0 ? x.marketVolUsd : 0;
  const volShare = vol > 0 ? x.sizeUsd / vol : 0;
  const volThresh = isNum(o.watchVolShare) ? o.watchVolShare : 0.08;     // ≥8% of 24h volume = a whale
  const outsizedVol = volShare >= volThresh;
  const outsizedPeers = enoughPeers && (z >= 3 || whaleX >= 10);
  const fired = []; let score = 0;
  if (outsizedVol || outsizedPeers) { fired.push("outsized"); score += WATCH_W.outsized; }
  // long-shot CONVICTION: a material BUY into an outcome the market prices as unlikely (≤ tau).
  const lsMax = isNum(o.watchLongshotMax) ? o.watchLongshotMax : 0.35;
  const lsMin = isNum(o.watchLongshotMinUsd) ? o.watchLongshotMinUsd : 2500;
  if (isNum(x.entryPrice) && x.entryPrice > 0 && x.entryPrice <= lsMax && x.sizeUsd >= lsMin) { fired.push("longshot"); score += WATCH_W.longshot; }
  if (x.walletFlagged === true) { fired.push("repeat"); score += WATCH_W.repeat; }   // already a published Suspect (bridge to the wallet tracker)
  if (x.fresh === true) { fired.push("fresh"); score += WATCH_W.fresh; }             // first-ever trade ≈ this bet (no track record)
  // INFORMATION ENVIRONMENT — DIRECTIONAL. This is the "did they trade ahead of the information?" axis.
  //   blackout (+, HIGHEST): NO public news matched the market's topic in the window before the bet —
  //     betting big before there is any public news is the clearest "they knew first" tell.
  //   anticipated (+): a matching regulatory filing was published AFTER the bet → it foresaw a real,
  //     not-yet-public regulatory action (the forward-looking half of the old fedRegister signal).
  //   publicInfo (−, EXCULPATORY): news OR a matching filing PREDATED the bet → it was likely placed on
  //     PUBLIC information, so it LOWERS the score. (The old fedRegister added a flat + for ANY filing
  //     match regardless of timing, conflating "anticipated a filing" with "acted on a public one".)
  if (x.blackout === true) { fired.push("blackout"); score += WATCH_W.blackout; }
  if (x.anticipated === true) { fired.push("anticipated"); score += WATCH_W.anticipated; }
  if (x.publicInfo === true) { fired.push("publicInfo"); score += WATCH_W.publicInfo; }
  return { score, fired, sizeZ: +z.toFixed(1), whaleX: +whaleX.toFixed(1), volShare: +(volShare * 100).toFixed(2), p90: Math.round(p90), nPeers, enoughPeers };
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
  // CROSS-CATEGORY improbability (full-record, mixed-odds) — a SECOND statistical flag basis for the
  // near-perfect serial winner the long-shot binomial misses (AlphaRaccoon, ricosuave). It uses a
  // normal approximation over mixed odds (less exact in the extreme tail than the binomial), so it
  // is capped at High, never Extreme, and still requires ≥2 agreeing detectors.
  const Pcc = dets.crossCat && dets.crossCat.hasData && dets.crossCat.fires ? dets.crossCat.P : null;
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
  //  (3) the CROSS-CATEGORY path — a full-record, mixed-odds improbable winner CORROBORATED by ≥2
  //      agreeing detectors. Capped at High (the normal-tail approximation is conservative in the
  //      extreme), it catches the moderate-odds serial winner the long-shot binomial cannot see.
  const ccFlags = Pcc != null && agreeing >= o.minAgree && Pcc <= o.pHigh;
  let tier = "unflagged";
  if (P != null && agreeing >= o.minAgree && P <= o.pExtreme) tier = "extreme";
  else if (P != null && agreeing >= o.minAgree && P <= o.pHigh) tier = "high";
  else if (ccFlags) tier = "high";
  else if (convFires && agreeing >= o.minAgree) tier = "high";
  else if (firedKeys.length && (P == null || P <= o.pNotable || (Pcc != null && Pcc <= o.pNotable))) tier = "notable";

  return {
    tier, fired: firedKeys, contributions, agreeing,
    convictionPath: convFires && tier === "high" && !ccFlags && (P == null || P > o.pHigh),
    crossCatPath: ccFlags && (P == null || P > o.pHigh),
    P, Pcc, improbDenom: dets.won && dets.won.improbDenom, improbText: dets.won && dets.won.improbText,
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
 *    S = 30·z_profit_cross + 25·z_bet_cross + 20·z_bet_within
 *        + 15·late_buy_fraction + 10·directional_score
 *    (z's are raw signed z-scores; late_buy_fraction and directional_score are in [0,1] — NO ·100)
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
// WEIGHTS — Harvard's LOCKED composite (Ofir & Ofir): profit 30, bet-cross 25, bet-within 20,
// timing 15, directionality 10. All FIVE signals are scored. CRITICAL SCALE NOTE: the z-terms are
// raw z's (weight·z, can be tens), so a single bet-size z is the spine of the score; late and dir
// are fractions in [0,1] and enter as weight·fraction — late contributes [0,15], dir [0,10]. They
// are minor ordering nudges, exactly as the paper intends. (An earlier version multiplied late/dir
// by 100 — a UNITS BUG that turned a 15-point feature into a 1,500-point one, swamping the z-spine
// and letting big LOSING bets score "extreme". It also blamed "saturation on a partial sample", but
// late/dir are PER-WALLET ratios computed over the FULL per-market trade list in aggregateMarket, so
// they're reliable and well-spread across [0,1] — the real defect was the scale, not the data.) The
// profitability gate below, NOT excluding late/dir, is what keeps losing bets out.
const HARVARD_W = { profitCross: 30, betCross: 25, betWithin: 20, late: 15, dir: 10 };
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
  const S = HARVARD_W.profitCross * zpc + HARVARD_W.betCross * zbc + HARVARD_W.betWithin * zbw
          + HARVARD_W.late * late + HARVARD_W.dir * dir;   // all 5 signals; late/dir on [0,1] (NO ·100)
  // PROFITABILITY GATE: informed trading is PROFITABLE. Retain only episodes that WON and
  // out-profited their peers (z_profit_cross > 0), on top of Harvard's outsized-bet gate. This is
  // what stops a big LOSING bet from scoring high just because it was large/late/one-sided.
  const won = e.won === true;
  const profitable = won && zpc > 0;
  const retained = (zbc > 2 || zbw > 2) && profitable;
  return {
    key: "harvard", hasData: true, S: +S.toFixed(1), retained, profitable, won,
    zBetCross: +zbc.toFixed(2), zBetWithin: +zbw.toFixed(2), zProfitCross: +zpc.toFixed(2),
    lateBuyFraction: +late.toFixed(3), directionalScore: +dir.toFixed(3),
  };
}
// Tier from the full 5-signal composite S. Calibrated to OUR gated distribution (material profit ≥
// $1k, entry odds ≤ 70%, winners only), NOT the paper's absolute 200/500 scale — our per-market
// cross-sections truncate the peer set at the 4000-trade cap, which shrinks the SD denominator and
// inflates the z's ~2× for mega-markets. So these cutoffs RANK suspicion within our data (extreme ≈
// top few %), they are not paper-comparable. Re-fit from a fresh shadow run after any weight change;
// tunable via opts.harvardTiers / the publish path.
const HARVARD_TIERS = { notable: 530, high: 810, extreme: 1110 };
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
  decorrelate, won, crossCat, longshot, held, fresh, baseline, profitCross, concealment, conviction, timing, repeat,
  concentration, sizing, clusterLink, clusterScore, fuse, winBaseline, categoryRisk, normalUpperTail,
  extractEntities, corrKey: corrKeyOf, betGroupKey, newsBlackout, fedRegister, watchlistScore, WATCH_W,
  harvardEpisode, harvardTier, HARVARD_W, HARVARD_TIERS,
};
