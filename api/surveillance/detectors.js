/* ============================================================================
 *  detectors.js — pure, framework-agnostic market-surveillance detectors
 *  ---------------------------------------------------------------------------
 *  Zero dependencies. Every detector is a pure function returning a sub-score in
 *  [0,1] plus the raw numbers it used and a one-line plain-English explainer, so
 *  the same object can drive both the ranking math and the UI's "show the math".
 *  These are transparent, auditable statistics a lawyer can follow — no ML, no
 *  neural nets, no heavy deps.
 *
 *  Used server-side by /api/surveillance/feed.js and unit-tested by
 *  detectors.test.js (`node --test api/surveillance/`).
 *
 *  Methods (all computed in LOG-ODDS space):
 *    1. runUp         Keown-Pinkerton event study / FINRA-SONAR core
 *    2. vpin          Easley-Lopez de Prado-O'Hara order-flow toxicity
 *    3. priceImpact   Kyle's lambda + Amihud illiquidity
 *    4. concentration Herfindahl-Hirschman index + fresh-wallet + top-1 share
 *    5. newsGap       SONAR explanation gate (E)
 *    6. liquidityQ    thin-market confidence gate (Q)
 *  fuse() renormalises the available detectors into a 0-100 suspicion index and
 *  classify() assigns the human label.
 * ========================================================================== */
"use strict";

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isNum = (x) => typeof x === "number" && isFinite(x);

/* ---- log-odds space -------------------------------------------------------
 * For a probability p, z = ln(p/(1-p)); the logit return is r_t = z_t - z_{t-1}.
 * p is clamped to [0.001, 0.999] so a tick against 0/1 can't explode the logit. */
function logit(p) { p = clip(p, 0.001, 0.999); return Math.log(p / (1 - p)); }

function logitReturns(probs) {
  const z = probs.map(logit);
  const r = [];
  for (let i = 1; i < z.length; i++) r.push(z[i] - z[i - 1]);
  return r;
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function stdev(a, mu) {
  if (a.length < 2) return 0;
  const m = mu == null ? mean(a) : mu;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
}
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Standard-normal CDF (Abramowitz & Stegun 7.1.26 via erf). Used by VPIN's bulk
// volume classification. Max abs error ~1.5e-7.
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/* ---- tuning constants (one exported home, exposed for tuning) -------------
 * Severity thresholds + the empirical baselines from the real-case calibration:
 * the ACDC longshot screen (>= $2,500 at <= 0.35 implied) and the observed
 * win-rate baselines by category (14% all / 25% political / 52% military). */
const DEFAULTS = {
  w: [0.30, 0.25, 0.20, 0.25],   // [runUp, vpin, priceImpact, concentration]
  gamma: 0.6,                    // news discount: Score = 100*clip(Raw*(1-gamma*E)*categoryMult)
  tauQ: 0.25,                    // Q at/below this => capped at Watch (low-liquidity artifact)
  kRunUp: 4,                     // CAR* divisor; |CAR*| >= k saturates the sub-score
  estFrac: 0.6,                  // fraction of the series used as the estimation window
  vpinN: 50, vpinBuckets: 50,
  freshWalletHours: 48,          // wallet first active within N hours of the move is "fresh"
  // severity banding (a market reaches High-signal ONLY with full coverage + >=2 agreeing detectors)
  agreeSub: 0.45,                // a detector "agrees" when its sub-score is at/above this
  tierHigh: 70, tierElevated: 50, tierWatch: 30,
  // ACDC longshot screen + win-rate baselines
  longshotUsd: 2500, longshotImplied: 0.35,
  winBaseline: { all: 0.14, political: 0.25, elections: 0.25, world: 0.52, business: 0.20, economy: 0.18, finance: 0.18, culture: 0.30, health: 0.20, "tech & science": 0.20 },
  // category/role risk multiplier (military/exec/central-bank/self-referential up; weather/sports down)
  categoryMult: { world: 1.25, politics: 1.2, elections: 1.2, economy: 1.1, finance: 1.1, business: 1.1, health: 1.05, "tech & science": 1.0, culture: 0.95 },
  holdToResolution: 0.03,        // selling < 3% before resolution = conviction signature
  lookbackDays: 90, graceDays: 14,
  // §0A deployment-profile knobs (rolling coverage on a cron)
  ENRICH_BATCH: 250, MAX_STALENESS_H: 6, CRON_INTERVAL_MIN: 15, PUBLISH_THRESHOLD: "High-signal",
  // manipulation-engine weights [washTrade, ramp, vpin, priceImpact]
  wManip: [0.30, 0.25, 0.20, 0.25],
};
// Streaming-only detectors that this serverless+cron stack cannot run (§0A.1).
// Surfaced in the UI as an explicit capability boundary — never a silent zero.
const STREAMING_ONLY = {
  available: false,
  reason: "Spoofing & layering are defined by order *cancels*, which exist only in a live websocket stream. This build is serverless + cron (no always-on recorder), so these are out of scope and shown here honestly rather than scored 0.",
};
function categoryMult(cat) {
  const m = DEFAULTS.categoryMult[String(cat || "").toLowerCase()];
  return isNum(m) ? m : 1;
}
function winBaseline(cat) {
  const b = DEFAULTS.winBaseline[String(cat || "").toLowerCase()];
  return isNum(b) ? b : DEFAULTS.winBaseline.all;
}

/* ============================================================================
 *  1. PRE-EVENT RUN-UP  —  Keown-Pinkerton event study (FINRA SONAR core)
 *  Estimate mu, sigma of the logit returns over an estimation window, then
 *  standardise abnormal returns AR_t = r_t - mu over the event (recent) window
 *  and cumulate: CAR = sum SAR_t, CAR* = CAR / sqrt(n). Sub-score = min(1,|CAR*|/k).
 *  series: [{t, p}] (t unix seconds, p probability). Returns null if too short.
 * ========================================================================== */
function runUp(series, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!Array.isArray(series)) return null;
  const pts = series
    .filter((x) => x && isNum(x.p) && x.p > 0 && x.p < 1 && isNum(x.t))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 8) return null;

  const r = logitReturns(pts.map((x) => x.p));        // length pts.length-1
  const split = Math.max(3, Math.floor(r.length * o.estFrac));
  const est = r.slice(0, split);
  const evt = r.slice(split);
  if (est.length < 3 || evt.length < 1) return null;

  const mu = mean(est);
  const sigma = stdev(est, mu);
  if (!(sigma > 0)) return null;

  const sar = evt.map((rt) => (rt - mu) / sigma);     // standardised abnormal returns
  const car = sar.reduce((a, b) => a + b, 0);         // cumulative
  const carStar = car / Math.sqrt(evt.length);        // standardised CAR
  const score = clip(Math.abs(carStar) / o.kRunUp, 0, 1);

  const dir = car >= 0 ? "up" : "down";
  // Keown-Pinkerton "fraction of the total move that happened in the pre-catalyst
  // window" — leakage shows up as most of the repricing BEFORE the public event.
  const z = pts.map((x) => logit(x.p));
  const totalMove = Math.abs(z[z.length - 1] - z[0]);
  const eventMove = Math.abs(z[z.length - 1] - z[split]);
  const preMoveFraction = totalMove > 0 ? +clip(eventMove / totalMove, 0, 1).toFixed(2) : 0;
  return {
    score, carStar: +carStar.toFixed(3), car: +car.toFixed(3), n: evt.length,
    mu: +mu.toFixed(4), sigma: +sigma.toFixed(4), dir, preMoveFraction,
    sigma_move: +Math.abs(carStar).toFixed(2),
    explain: "Implied probability drifted " + dir + " " + Math.abs(carStar).toFixed(1) +
      "σ beyond this market's own normal swings over the pre-event window (Keown–Pinkerton)" +
      (preMoveFraction >= 0.5 ? "; about " + Math.round(preMoveFraction * 100) + "% of the whole move happened before the outcome was public." : "."),
  };
}

/* ============================================================================
 *  2. ORDER-FLOW TOXICITY  —  VPIN (Easley, Lopez de Prado, O'Hara)
 *  Bucket trades into fixed-volume buckets (size ~= total volume / vpinBuckets).
 *  Within each bucket, split volume buy/sell by bulk volume classification:
 *  buyFrac = Phi(dz / sigma_dz). VPIN = (1/N) sum |Vsell-Vbuy|/V over last N buckets.
 *  trades: [{ts, price(prob), size}] in time order (resorted defensively).
 * ========================================================================== */
function vpin(trades, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!Array.isArray(trades)) return null;
  const tr = trades
    .filter((t) => t && isNum(t.size) && t.size > 0 && isNum(t.price) && t.price > 0 && t.price < 1)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (tr.length < 12) return null;

  // per-trade logit change + its volatility (for the standardisation in BVC)
  const dz = [0];
  for (let i = 1; i < tr.length; i++) dz.push(logit(tr[i].price) - logit(tr[i - 1].price));
  const sdz = stdev(dz.slice(1));
  if (!(sdz > 0)) return null;

  const totalVol = tr.reduce((s, t) => s + t.size, 0);
  const bucketSize = totalVol / o.vpinBuckets;
  if (!(bucketSize > 0)) return null;

  // fill fixed-volume buckets, splitting a trade across a boundary
  const buckets = [];
  let curBuy = 0, curSell = 0, curFill = 0;
  for (let i = 0; i < tr.length; i++) {
    const buyFrac = normCdf(dz[i] / sdz);
    let remaining = tr[i].size;
    while (remaining > 1e-9) {
      const room = bucketSize - curFill;
      const take = Math.min(remaining, room);
      curBuy += take * buyFrac;
      curSell += take * (1 - buyFrac);
      curFill += take;
      remaining -= take;
      if (curFill >= bucketSize - 1e-9) {
        buckets.push(Math.abs(curSell - curBuy) / bucketSize);
        curBuy = 0; curSell = 0; curFill = 0;
      }
    }
  }
  if (buckets.length < 3) return null;

  const window = buckets.slice(-o.vpinN);
  const v = mean(window);
  const score = clip(v, 0, 1);
  return {
    score, vpin: +v.toFixed(3), nBuckets: buckets.length, nTrades: tr.length,
    explain: Math.round(v * 100) + "% of recent volume pushed one direction — the " +
      "order-flow imbalance (VPIN) that flags informed trading (Easley–López de Prado–O'Hara).",
  };
}

/* ============================================================================
 *  3. PRICE IMPACT / LIQUIDITY VACUUM  —  Kyle's lambda + Amihud
 *  Kyle's lambda = OLS slope of dp_t ~ OFI_t (signed order flow). Amihud
 *  illiquidity = |r_t| / dollarVolume_t. Sub-score = how extreme recent lambda/
 *  Amihud is vs the market's own rolling median (ratio, squashed to [0,1]).
 *  bars: [{t, p, volume}] (volume = dollar volume in that bar). OFI optional;
 *  when absent we use signed price change * volume as a proxy.
 * ========================================================================== */
function priceImpact(bars, opts) {
  Object.assign({}, DEFAULTS, opts);
  if (!Array.isArray(bars)) return null;
  const b = bars
    .filter((x) => x && isNum(x.p) && x.p > 0 && x.p < 1 && isNum(x.volume) && x.volume >= 0)
    .sort((a, b2) => a.t - b2.t);
  if (b.length < 6) return null;

  // per-bar logit return and signed order-flow proxy
  const rows = [];
  for (let i = 1; i < b.length; i++) {
    const dp = logit(b[i].p) - logit(b[i - 1].p);
    const vol = b[i].volume;
    const ofi = isNum(b[i].ofi) ? b[i].ofi : Math.sign(dp) * vol;   // signed flow
    rows.push({ dp, vol, ofi, amihud: vol > 0 ? Math.abs(dp) / vol : 0 });
  }
  if (rows.length < 5) return null;

  // Kyle's lambda: slope of dp ~ a + lambda*ofi
  const xs = rows.map((r) => r.ofi), ys = rows.map((r) => r.dp);
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
  const lambda = sxx > 0 ? sxy / sxx : 0;

  // Amihud: how extreme is the most recent illiquidity vs the market's own median?
  const amihudSeries = rows.map((r) => r.amihud).filter((x) => x > 0);
  const medAmihud = median(amihudSeries);
  const recentAmihud = median(rows.slice(-3).map((r) => r.amihud).filter((x) => x > 0));
  const ratio = medAmihud > 0 ? recentAmihud / medAmihud : (recentAmihud > 0 ? 3 : 0);

  // squash the impact ratio: 1x => ~0, 3x => ~0.5, >=12x => ~1
  const score = clip(Math.log2(Math.max(1, ratio)) / Math.log2(12), 0, 1);
  return {
    score, lambda: +lambda.toFixed(5), amihud: +recentAmihud.toExponential(2),
    impactRatio: +ratio.toFixed(1),
    explain: ratio >= 2
      ? "A large move achieved on little resting capital — a " + ratio.toFixed(1) +
        "× liquidity vacuum vs this market's normal price impact (Kyle's λ, Amihud)."
      : "Price impact in line with this market's normal liquidity.",
  };
}

/* ============================================================================
 *  4. TRADER CONCENTRATION  —  Herfindahl-Hirschman index + fresh-wallet + top-1
 *  Polymarket only (Kalshi trades are anonymous). From per-wallet BUY volumes:
 *  HHI = sum s_i^2 (0..1; 1 = single wallet). Sub-score blends HHI, the top-1
 *  share, and a fresh-wallet boost.
 *  wallets: [{ wallet, buyUsd, firstActiveTs? }], moveTs (unix s) optional.
 * ========================================================================== */
function concentration(wallets, moveTs, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  if (!Array.isArray(wallets)) return null;
  const ws = wallets.filter((w) => w && isNum(w.buyUsd) && w.buyUsd > 0);
  if (ws.length < 3) return null;

  const total = ws.reduce((s, w) => s + w.buyUsd, 0);
  if (!(total > 0)) return null;
  const shares = ws.map((w) => w.buyUsd / total);
  const hhi = shares.reduce((s, x) => s + x * x, 0);

  let top = ws[0];
  for (const w of ws) if (w.buyUsd > top.buyUsd) top = w;
  const top1 = top.buyUsd / total;

  let fresh = false;
  if (isNum(moveTs) && isNum(top.firstActiveTs)) {
    fresh = (moveTs - top.firstActiveTs) <= o.freshWalletHours * 3600 && top.firstActiveTs <= moveTs + 3600;
  }

  // blend: HHI and top-1 share both push the score; fresh wallet adds a boost.
  const score = clip(0.55 * hhi + 0.45 * top1 + (fresh ? 0.15 : 0), 0, 1);
  return {
    score, hhi: +hhi.toFixed(3), top1: +top1.toFixed(3), nWallets: ws.length,
    fresh, topWallet: top.wallet || null,
    explain: "One account was " + Math.round(top1 * 100) + "% of recent buying (HHI " +
      hhi.toFixed(2) + (fresh ? ", from a wallet first active hours before the move" : "") +
      ") — concentrated, not crowd-driven.",
  };
}

/* ============================================================================
 *  5. NEWS-CONTEXT GAP  —  the SONAR explanation gate (E in [0,1])
 *  E = strength of a credible PUBLIC event near the move. Credibility:
 *  official(1.0) > news(0.7) > social(0.4). Scaled by time-proximity, novelty,
 *  and direction-match. A big move AFTER a credible public event => high E
 *  (explained); a move BEFORE, with nothing public => low E (unexplained).
 *  ctx: { credibility:'official'|'news'|'social', hoursFromMove, directionMatch,
 *         preEvent } | null  (null => unknown, E=0, not cleared).
 * ========================================================================== */
function newsGap(ctx) {
  if (!ctx) return { E: 0, explained: false, preEvent: true, explain: "No public catalyst found around the move — unexplained." };
  const cred = ctx.credibility === "official" ? 1.0 : ctx.credibility === "news" ? 0.7 : ctx.credibility === "social" ? 0.4 : 0;
  if (!cred) return { E: 0, explained: false, preEvent: true, explain: "No credible public catalyst near the move." };
  const h = isNum(ctx.hoursFromMove) ? Math.abs(ctx.hoursFromMove) : 48;
  // proximity: at the move => 1, decays to ~0 by 48h
  const prox = clip(1 - h / 48, 0, 1);
  // a catalyst that lands BEFORE the move explains it; one only AFTER does not.
  const preEvent = ctx.preEvent === true;
  const dirOk = ctx.directionMatch !== false ? 1 : 0.4;
  const E = preEvent ? 0 : clip(cred * prox * dirOk, 0, 1);
  return {
    E: +E.toFixed(3), explained: E >= 0.5, preEvent, credibility: ctx.credibility,
    explain: preEvent
      ? "The sharp move PRECEDED the first public headline — a pre-event gap (unexplained)."
      : (E >= 0.5
        ? "A credible public headline around this move plausibly explains it (explained)."
        : "Only a weak/distant public signal near the move (partially explained)."),
  };
}

/* ============================================================================
 *  6. LIQUIDITY-CONFIDENCE GATE  —  Q in [0,1]
 *  Guards against thin-market noise. Normalise volume/spread/depth/tradeCount to
 *  [0,1] (spread inverted) and weight ~0.4/0.3/0.2/0.1. Low Q => the swing may be
 *  a low-liquidity artifact, not informed trading.
 *  inputs: { volumeUsd, spread (0..1), depthUsd, tradeCount }
 * ========================================================================== */
function liquidityQ(inputs) {
  const i = inputs || {};
  // Calibrated to prediction-market scales: a "real" book is $10k–$1M+; sub-$1k
  // is thin. log-scaled with an offset so tiny books normalise to ~0.
  const vN = clip((Math.log10(Math.max(1, i.volumeUsd || 0)) - 3) / 3, 0, 1);  // $1k => 0, $100k => .67, $1M => 1
  const sN = isNum(i.spread) ? clip(1 - i.spread / 0.1, 0, 1) : 0.5;           // 0 spread => 1, >=10c => 0
  const dN = clip((Math.log10(Math.max(1, i.depthUsd || 0)) - 2) / 3, 0, 1);   // $100 => 0, $100k => 1
  const tN = clip(Math.log10(Math.max(1, i.tradeCount || 0)) / 3, 0, 1);       // 1 => 0, 1000 => 1
  const Q = clip(0.4 * vN + 0.3 * sN + 0.2 * dN + 0.1 * tN, 0, 1);
  return {
    Q: +Q.toFixed(3), vN: +vN.toFixed(2), sN: +sN.toFixed(2), dN: +dN.toFixed(2), tN: +tN.toFixed(2),
    explain: Q <= DEFAULTS.tauQ
      ? "Thin book — a small trade can swing the price, so a flag here may be a low-liquidity artifact."
      : "Liquid enough that the move is unlikely to be a thin-book artifact.",
  };
}

/* ============================================================================
 *  FUSION  ->  suspicion score (0-100) + coverage + severity tier + label
 *  `dets` is the list of checks APPLICABLE to this market/engine, each
 *  { key, weight, sub|null } (sub=null means the check could not run — no data).
 *  We renormalise the weighted sum over ONLY the checks that ran, and report
 *  coverage (ran / applicable) so the UI shows "3/4 checks ran" instead of fake
 *  "n/a +0" rows. The score therefore varies with whatever ran — but the
 *  SEVERITY TIER is gated: a market reaches High-signal only with FULL coverage
 *  AND >=2 independent detectors agreeing. That is the structural fix for
 *  "everything scores ~30 from one lonely check".
 *    Score = round(100 * clip(Raw * (1 - gamma*E) * categoryMult, 0, 1))
 * ========================================================================== */
function tierOf(x, o) {
  o = o || DEFAULTS;
  if (isNum(x.Q) && x.Q <= o.tauQ) return "Watch";                       // thin book caps at Watch
  if (x.fullCoverage && x.agreeing >= 2 && x.score >= o.tierHigh) return "High-signal";
  if (x.score >= o.tierElevated && x.agreeing >= 1) return "Elevated";
  if (x.score >= o.tierWatch) return "Watch";
  return "Clear";
}
function fuse(dets, ctx, opts) {
  const o = Object.assign({}, DEFAULTS, opts);
  ctx = ctx || {};
  const applicable = (Array.isArray(dets) ? dets : []).filter((d) => d && isNum(d.weight));
  const subOf = (s) => (s == null ? null : (typeof s === "number" ? s : (isNum(s.score) ? s.score : null)));
  const ran = applicable.map((d) => ({ key: d.key, weight: d.weight, sub: subOf(d.sub) })).filter((d) => d.sub != null);
  const total = applicable.length;
  if (!ran.length) return { score: 0, raw: 0, E: 0, coverageRan: 0, coverageTotal: total, fullCoverage: false, agreeing: 0, tier: "Insufficient data", label: "Insufficient data", contributions: [] };

  const wsum = ran.reduce((s, d) => s + d.weight, 0);
  const raw = ran.reduce((s, d) => s + (d.weight / wsum) * d.sub, 0);   // RENORMALISED over ran
  const E = isNum(ctx.E) ? ctx.E : (ctx.news && isNum(ctx.news.E) ? ctx.news.E : 0);
  const mult = isNum(ctx.categoryMult) ? ctx.categoryMult : 1;
  const disc = clip((1 - o.gamma * E) * mult, 0, 1.5);
  const score = Math.round(100 * clip(raw * disc, 0, 1));
  const agreeing = ran.filter((d) => d.sub >= o.agreeSub).length;
  const fullCoverage = ran.length === total && total > 0;
  const tier = tierOf({ score, agreeing, fullCoverage, Q: ctx.Q }, o);
  const label = classify({ raw, E, Q: ctx.Q, preEvent: ctx.preEvent, tauQ: o.tauQ });
  return {
    score, raw: +raw.toFixed(3), E: +E.toFixed(3),
    coverageRan: ran.length, coverageTotal: total, fullCoverage, agreeing, tier, label,
    contributions: ran.map((p) => ({
      key: p.key, score: +p.sub.toFixed(3), weight: +(p.weight / wsum).toFixed(3),
      points: Math.round(100 * (p.weight * p.sub / wsum) * clip(disc, 0, 1)),
    })),
  };
}

/* ACDC longshot + win-rate-vs-implied screen (resolved markets, Polymarket).
 * A large bet (>= $2,500) at a low implied (<= 0.35) that RESOLVED in the
 * bettor's favour is the core insider fingerprint. Winning repeatedly near 0%
 * implied is the top of the scale. inputs:
 *   { stakeUsd, impliedProb, won (bool), category } -> {score, hasData, explain} */
function longshot(x) {
  if (!x || !isNum(x.stakeUsd) || !isNum(x.impliedProb)) return null;
  const isLongshot = x.stakeUsd >= DEFAULTS.longshotUsd && x.impliedProb <= DEFAULTS.longshotImplied;
  if (!isLongshot) return { score: 0, hasData: true, isLongshot: false, explain: "No large low-priced position to flag for this market." };
  const base = winBaseline(x.category);
  if (x.won == null) return { score: clip((0.35 - x.impliedProb) / 0.35 * 0.4, 0, 0.5), hasData: true, isLongshot: true, won: null,
    explain: "A large bet (~$" + Math.round(x.stakeUsd).toLocaleString() + ") was placed at only " + Math.round(x.impliedProb * 100) + "% implied odds." };
  // won: how far below "fair" the entry was, lifted vs the category baseline
  const edge = x.won ? clip((1 - x.impliedProb), 0, 1) : 0;
  const vsBase = x.won ? clip((base - x.impliedProb) / Math.max(0.05, base), 0, 1) : 0;
  const score = x.won ? clip(0.45 + 0.4 * edge + 0.15 * vsBase, 0, 1) : 0.1;
  return {
    score, hasData: true, isLongshot: true, won: x.won, impliedProb: x.impliedProb, baseline: base,
    explain: x.won
      ? ("A large bet won at just " + Math.round(x.impliedProb * 100) + "% implied odds — where bets like this win about " + Math.round(base * 100) + "% of the time. Winning anyway is the longshot fingerprint regulators look for.")
      : "A large low-priced bet that did not pay out.",
  };
}

/* Label, in priority order:
 *  Low-liquidity artifact (Q <= tauQ) > Explained (E high, not pre-event) >
 *  Unexplained (high Raw, low E, pre-event) > Partially explained. */
function classify(x) {
  const tauQ = isNum(x.tauQ) ? x.tauQ : DEFAULTS.tauQ;
  if (isNum(x.Q) && x.Q <= tauQ) return "Low-liquidity artifact";
  const E = isNum(x.E) ? x.E : 0;
  const raw = isNum(x.raw) ? x.raw : 0;
  if (E >= 0.5 && x.preEvent !== true) return "Explained";
  if (raw >= 0.5 && E < 0.3 && x.preEvent === true) return "Unexplained";
  if (raw >= 0.5 && E < 0.3) return "Unexplained";
  return "Partially explained";
}

/* INSIDER 2 — pre-event accumulation + hold-to-resolution (Polymarket wallets).
 * A large one-directional position built BEFORE resolution and held through it
 * (sold < holdToResolution before settlement) is the conviction signature
 * (Van Dyke / ACDC). inputs { netPreUsd, soldFracPre, won }. */
function accumulation(x) {
  if (!x || !isNum(x.netPreUsd)) return null;
  const size = clip(Math.log10(Math.max(1, Math.abs(x.netPreUsd))) / 5, 0, 1);   // $1 => 0, $100k => 1
  const held = isNum(x.soldFracPre) ? (x.soldFracPre <= DEFAULTS.holdToResolution ? 1 : clip(1 - x.soldFracPre / 0.2, 0, 1)) : 0.5;
  const win = x.won === true ? 1 : x.won === false ? 0 : 0.5;
  const score = clip(0.45 * size + 0.30 * held + 0.25 * win, 0, 1);
  return {
    score, hasData: true, netPreUsd: Math.round(x.netPreUsd), soldFracPre: x.soldFracPre,
    held: isNum(x.soldFracPre) && x.soldFracPre <= DEFAULTS.holdToResolution,
    explain: "A one-directional position of about $" + Math.round(Math.abs(x.netPreUsd)).toLocaleString() +
      " was built before the outcome and " + (isNum(x.soldFracPre) && x.soldFracPre <= 0.03 ? "held all the way to resolution" : "mostly held into resolution") +
      " — the hold-to-resolution conviction signature.",
  };
}
/* INSIDER 2 (Kalshi) — abnormal pre-event volume vs the market's own baseline. */
function volumeRunup(x) {
  if (!x || !isNum(x.preVol) || !isNum(x.baseVol) || x.baseVol <= 0) return null;
  const ratio = x.preVol / x.baseVol;
  const score = clip(Math.log2(Math.max(1, ratio)) / Math.log2(10), 0, 1);       // 1x => 0, 10x => 1
  return { score, hasData: true, ratio: +ratio.toFixed(1),
    explain: "Pre-event trading volume was " + ratio.toFixed(1) + "× this market's normal level — abnormal interest building before the outcome." };
}

/* MANIPULATION 1 — wash / self-trading (Polymarket; Kalshi weaker).
 * Same or linked wallets on both sides of fills, or offsetting round-trips that
 * inflate volume with no net position change. inputs { selfMatchedUsd, totalUsd, linkedPairs }. */
function washTrade(x) {
  if (!x || !isNum(x.totalUsd) || x.totalUsd <= 0) return null;
  const selfFrac = clip((x.selfMatchedUsd || 0) / x.totalUsd, 0, 1);
  const linked = clip((x.linkedPairs || 0) / 5, 0, 1);
  const score = clip(0.7 * selfFrac + 0.3 * linked, 0, 1);
  return { score, hasData: true, selfFrac: +selfFrac.toFixed(2), linkedPairs: x.linkedPairs || 0,
    explain: Math.round(selfFrac * 100) + "% of volume traced to the same or linked wallets trading with themselves — wash trading inflates volume without real risk." };
}
/* MANIPULATION 2 — ramp / marking-the-close / settlement pressure (price-tape).
 * Volume + price pressure concentrated into the close/expiry (Archegos/Gallagher
 * footprint). inputs { closeVolFrac, moveIntoClose, volVsBaseline }. */
function ramp(x) {
  if (!x || !isNum(x.closeVolFrac)) return null;
  const conc = clip(x.closeVolFrac / 0.5, 0, 1);                                  // half the day's volume in the close => 1
  const move = isNum(x.moveIntoClose) ? clip(Math.abs(x.moveIntoClose) / 1.0, 0, 1) : 0;
  const vol = isNum(x.volVsBaseline) ? clip(Math.log2(Math.max(1, x.volVsBaseline)) / Math.log2(8), 0, 1) : 0;
  const score = clip(0.5 * conc + 0.3 * move + 0.2 * vol, 0, 1);
  return { score, hasData: true, closeVolFrac: +x.closeVolFrac.toFixed(2),
    explain: Math.round(x.closeVolFrac * 100) + "% of the period's volume hit in the final window, pushing the price into settlement — the marking-the-close / ramp footprint." };
}

module.exports = {
  DEFAULTS, STREAMING_ONLY, clip, logit, logitReturns, mean, stdev, median, normCdf,
  runUp, vpin, priceImpact, concentration, newsGap, liquidityQ, longshot, accumulation, volumeRunup,
  washTrade, ramp, fuse, tierOf, classify, categoryMult, winBaseline,
};
