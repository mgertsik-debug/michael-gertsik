/* ============================================================================
 *  VALIDATION — does the flagged set actually beat chance, and which detectors
 *  carry real predictive weight? (Items 4 + 5 of the Harvard-derived upgrades.)
 *
 *  This is the honesty layer: instead of asserting the detectors work, it MEASURES
 *  it on the live flagged population and reports the result — including when the
 *  result is weak or the sample is too small to conclude anything.
 *
 *  (4) PERMUTATION / POPULATION NULL TEST. Take every flagged bet, with the odds the
 *      MARKET ITSELF priced it at (p) and whether it won. Under the null hypothesis
 *      "these wallets have no edge," each bet wins with probability p — the market's
 *      own number. We compute the expected wins (Σp), the standard deviation
 *      (√Σ p(1−p)), and how many SDs the OBSERVED win count sits above that null
 *      (the analytic Lyapunov-CLT z), and we CONFIRM it with a Monte-Carlo shuffle:
 *      simulate the whole flagged set ~10,000× drawing each bet at its market odds,
 *      count how often the simulated wins meet or beat what actually happened → an
 *      empirical p-value. This is the same shape as Harvard's Table 5 population test.
 *
 *  (5) PER-DETECTOR VALIDATION. For each detector, split the flagged wallets by whether
 *      that detector fired and compare win rates. A detector that carries signal shows a
 *      higher win rate when it fires (positive lift); one that is dead weight shows ~0 or
 *      negative lift. Reported WITH sample sizes so a 2-wallet "lift" isn't mistaken for
 *      evidence. This is what tells us which detectors to keep, down-weight, or cut.
 *
 *  Pure + deterministic (seeded RNG) so it is unit-testable and reproducible.
 * ========================================================================== */

// Deterministic RNG (mulberry32) — reproducible permutations, no Math.random.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isNum = (x) => typeof x === "number" && isFinite(x);
function pText(p) {
  if (p <= 0) return "p < 1e-7";
  if (p < 1e-6) return "p < 1e-6";
  if (p < 1e-4) return "p < 1e-4";
  if (p < 1e-3) return "p < 0.001";
  if (p < 0.01) return "p < 0.01";
  if (p < 0.05) return "p < 0.05";
  return "p = " + p.toFixed(2) + " (not significant)";
}

// Pull every INDEPENDENT flagged bet's (marketProb p in (0,1), won) from a subject's ledger.
// Ledger rows carry odds as an integer percent and outcome "Won"/"Lost". One row per
// (wallet, market) position; we keep them as independent events (the binomial path already
// de-correlated within a wallet's record before flagging, and across wallets they are distinct).
function flaggedBets(subjects) {
  const out = [];
  for (const s of subjects || []) {
    // FAVORITES subjects carry a FULL-record ledger but only ONE flagged bet (the cross-sectional
    // profit episode). Use just that episode — counting their incidental bets would misrepresent
    // "flagged bets" and contaminate the null. The binomial subjects' ledger IS the flagged
    // (≤35% long-shot) record, so for those we use every row.
    if (s.flaggedBy === "cross-sectional-profit" && s.harvardEpisode) {
      const ep = s.harvardEpisode; const p = isNum(ep.odds) ? ep.odds / 100 : null;
      if (p != null && p > 0 && p < 1) out.push({ p, won: !!ep.won });
      continue;
    }
    for (const r of (s.ledger || [])) {
      const p = isNum(r.odds) ? r.odds / 100 : null;
      if (p == null || p <= 0 || p >= 1) continue;
      const won = r.outcome ? /^win|^won/i.test(String(r.outcome)) : !!r.won;
      out.push({ p, won });
    }
  }
  return out;
}

// (4) Population null test: observed wins vs the market-odds null, analytic z + Monte-Carlo p.
function permutationTest(subjects, opts) {
  const o = Object.assign({ iters: 10000, seed: 0x1a2b3c4d }, opts);
  const bets = flaggedBets(subjects);
  const n = bets.length;
  if (n < 5) return { hasData: false, nBets: n, note: "too few flagged bets to test (" + n + ")" };
  const observed = bets.reduce((a, b) => a + (b.won ? 1 : 0), 0);
  const expected = bets.reduce((a, b) => a + b.p, 0);
  const variance = bets.reduce((a, b) => a + b.p * (1 - b.p), 0);
  const sd = Math.sqrt(variance);
  const z = sd > 0 ? (observed - expected) / sd : 0;
  // Monte-Carlo: simulate the whole flagged set drawing each bet at its market odds.
  const rand = rng(o.seed);
  let geObserved = 0; let sumSim = 0;
  for (let i = 0; i < o.iters; i++) {
    let wins = 0;
    for (let j = 0; j < n; j++) if (rand() < bets[j].p) wins++;
    sumSim += wins;
    if (wins >= observed) geObserved++;
  }
  const pEmpirical = geObserved / o.iters;
  const avgImplied = expected / n;
  return {
    hasData: true, nBets: n,
    observedWins: observed, expectedWins: Math.round(expected * 10) / 10, sd: Math.round(sd * 100) / 100,
    zScore: Math.round(z * 10) / 10, avgImplied: Math.round(avgImplied * 1000) / 10,   // %
    iters: o.iters, simMeanWins: Math.round((sumSim / o.iters) * 10) / 10,
    pEmpirical, pText: geObserved === 0 ? ("p < " + (1 / o.iters).toExponential(0)) : pText(pEmpirical),
    // PLAIN-ENGLISH, hedged: a measured fact about the whole flagged SET, not intent. Says "bets
    // placed by the N wallets" so the bet-count never reads as a contradiction of the wallet-count.
    statement: "Is this just luck? We took every long-shot bet placed by " + ((Array.isArray(subjects) && subjects.length) ? ("the " + subjects.length + " flagged wallets") : "the flagged wallets") +
      " — " + n.toLocaleString("en-US") + " bets in all — and used the market's own prices to work out how many they should win by pure guessing: about " + Math.round(expected).toLocaleString("en-US") +
      ". They actually won " + observed.toLocaleString("en-US") + ". We then re-ran every outcome " + o.iters.toLocaleString("en-US") + " times at random; the group beat chance by " + Math.round(z * 10) / 10 +
      " standard deviations (" + (geObserved === 0 ? "p < " + (1 / o.iters).toExponential(0) : pText(pEmpirical)) + ") — a margin so large it essentially never happens by accident. Strong evidence the group as a whole was trading on information; not proof for any single wallet.",
  };
}

// (5) Per-detector validation: win-rate lift when each detector fires vs not, with sample sizes.
function perDetectorValidation(subjects) {
  const subs = (subjects || []).filter((s) => isNum(s.winRate));
  const keys = new Set();
  subs.forEach((s) => (s.fired || []).forEach((k) => keys.add(k)));
  const rows = [];
  for (const key of keys) {
    const fired = subs.filter((s) => (s.fired || []).includes(key));
    const notFired = subs.filter((s) => !(s.fired || []).includes(key));
    if (!fired.length) continue;
    const wr = (arr) => arr.length ? arr.reduce((a, s) => a + s.winRate, 0) / arr.length : null;
    const fWR = wr(fired); const nWR = wr(notFired);
    rows.push({
      key, firedN: fired.length, notFiredN: notFired.length,
      firedWinRate: fWR != null ? Math.round(fWR * 10) / 10 : null,
      notFiredWinRate: nWR != null ? Math.round(nWR * 10) / 10 : null,
      lift: (fWR != null && nWR != null) ? Math.round((fWR - nWR) * 10) / 10 : null,
      // honesty flag: a lift over too few wallets is not evidence.
      reliable: fired.length >= 8 && notFired.length >= 8,
    });
  }
  rows.sort((a, b) => (b.lift == null ? -1e9 : b.lift) - (a.lift == null ? -1e9 : a.lift));
  return rows;
}

function validate(subjects, opts) {
  return {
    permutation: permutationTest(subjects, opts),
    perDetector: perDetectorValidation(subjects),
    flaggedCount: (subjects || []).length,
    computedAt: (opts && opts.now) || null,                // caller stamps (Date.now() banned in some contexts)
  };
}

module.exports = { validate, permutationTest, perDetectorValidation, flaggedBets, rng };
