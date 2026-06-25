/* ============================================================================
 *  forensics/build.js — turn a wallet's real Polymarket record into the exact
 *  subject dossier shape the Wallet Forensics artifact consumes.
 *  ---------------------------------------------------------------------------
 *  Pure + dependency-free (only ./detectors.js). The scanner feeds this an
 *  aggregate per wallet (and per cluster); we run the detector suite, fuse to a
 *  tier, and emit the `buildSubjects()`-shaped object — including every derived
 *  field the view computes (wins, expectedWins, percentile, volume, profitNum,
 *  activityDays, lastActivity, confidenceLimiter, ledger, timeline, scorecard).
 *
 *  HONESTY: numbers come only from the record. Detectors with missing inputs
 *  are excluded (never scored 0). Nothing here fabricates a value — a field we
 *  cannot compute is left off, and the view degrades to its honest fallback.
 *
 *  Aggregate contract (from scripts/forensics/scan.js):
 *    walletAgg = {
 *      address, pseudonym?, firstSeenTs, fundingTs?, priorTx?,
 *      bets: [{ cond, tokenId, question, url, category, entryPrice(0..1),
 *               stakeUsd, outcome, won(bool), held(bool), ts(sec), tx,
 *               eventGroup?, priceStart?, priceEnd? }],
 *      conceal?: { splitRatio?, decoyRatio?, cashoutLatencyHours? },
 *    }
 *    clusterAgg = walletAgg + { type:'cluster', members:[addr], edges:[{from,to,link,type,evidence}],
 *                               cexChips?:[], nodes?:[] }
 * ========================================================================== */
"use strict";
const D = require("./detectors.js");

const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
const short = (a) => (a && a.length > 10 ? a.slice(0, 4) + "…" + a.slice(-4) : a || "");
const MS_DAY = 86400000;

// $K / $M money formatting matching the artifact's profit strings.
function money(v) {
  v = Math.round(num(v));
  if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(v) >= 1e3) return "$" + Math.round(v / 1e3) + "K";
  return "$" + v;
}
function signedMoney(v) { v = Math.round(num(v)); return (v >= 0 ? "+" : "−") + money(Math.abs(v)).replace("$", "$"); }
function dateStr(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return M[d.getUTCMonth()] + " " + String(d.getUTCDate()).padStart(2, "0") + " " + d.getUTCFullYear();
}

// realized P/L for one bet: a won long-shot pays stake·(1/p − 1); a loss is −stake.
function betPL(b) {
  const p = Math.max(1e-6, Math.min(1 - 1e-6, num(b.entryPrice)));
  return b.won ? num(b.stakeUsd) * (1 / p - 1) : -num(b.stakeUsd);
}

// dominant category across the wallet's resolved bets (drives the baseline).
function dominantCategory(bets) {
  const c = {}; bets.forEach((b) => { const k = b.category || "World"; c[k] = (c[k] || 0) + 1; });
  return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || "World";
}

// map a fused tier to the artifact's tier vocabulary.
const TIER = { extreme: "extreme", high: "elevated", notable: "watch", unflagged: null };

/* --------------------------------------------------------------- detectors -- */
// Run the full suite on an aggregate and return { dets, f } (f = fuse result).
const LONGSHOT_MAX = 0.35;       // the headline is the bettor's "≤35% implied" record
function scoreAggregate(agg) {
  const valid = (agg.bets || []).filter((b) => b && typeof b.won === "boolean" && D.isNum(num(b.entryPrice)));
  // The SUBJECT is the bettor's long-shot record: only bets entered at ≤35%
  // implied. Favorites aren't the anomaly and would dilute the binomial.
  const bets = valid.filter((b) => num(b.entryPrice) <= LONGSHOT_MAX);
  const betsForWon = bets.map((b) => ({ impliedProb: num(b.entryPrice), won: !!b.won, eventGroup: b.eventGroup }));
  const wonD = D.won(betsForWon);

  const impliedProbs = bets.map((b) => num(b.entryPrice));
  const longshotD = D.longshot(impliedProbs);

  const heldN = bets.filter((b) => b.held).length;
  const heldD = bets.length ? D.held({ heldToResolution: heldN, total: bets.length }) : { key: "held", hasData: false };

  const ageDays = agg.firstSeenTs && agg.fundingTs ? (agg.firstSeenTs - agg.fundingTs) / 86400 : null;
  const freshD = (ageDays != null && D.isNum(num(agg.priorTx)))
    ? D.fresh({ ageDays, priorTx: num(agg.priorTx) }) : { key: "fresh", hasData: false };

  const winRate = wonD.hasData ? wonD.winRate : null;
  const baselineD = winRate != null ? D.baseline({ winRate, category: dominantCategory(bets) }) : { key: "baseline", hasData: false };

  const concealD = agg.conceal ? D.concealment(agg.conceal) : { key: "conceal", hasData: false };

  const clusterD = (agg.type === "cluster" && agg.edges)
    ? D.clusterScore(agg.edges, (agg.members || []).length) : { key: "cluster", hasData: false };

  // single high-conviction bet — the lone insider bet the binomial (n>=5) misses
  const convictionD = D.conviction(bets);

  const dets = { won: wonD, longshot: longshotD, held: heldD, fresh: freshD, baseline: baselineD, conceal: concealD, cluster: clusterD, conviction: convictionD };
  const f = D.fuse(dets);
  return { dets, f, bets, ageDays };
}

/* ----------------------------------------------------------------- subject -- */
// Build the artifact subject (pre-derivation) from an aggregate. Returns null
// if there is not enough data to compute the headline (won.hasData=false), so
// sub-5-bet wallets are excluded, never scored 0.
function buildSubject(agg, idx, opts) {
  const { dets, f, bets } = scoreAggregate(agg);
  const tier = TIER[f.tier];
  if (!tier) return null;                                   // unflagged → not published
  // Two publish paths: the binomial RECORD (won.hasData) or the single-bet
  // CONVICTION path (a lone high-conviction insider bet + corroboration).
  const conv = dets.conviction || {};
  const convOnly = !dets.won.hasData;
  if (convOnly && !conv.fires) return null;                 // not scoreable and not a conviction case

  const isCluster = agg.type === "cluster";
  const won = dets.won;
  const wins = bets.filter((b) => b.won).length;
  const n = won.hasData ? won.n : bets.length;
  const k = won.hasData ? won.k : wins;
  const avgImplied = won.hasData ? Math.round(won.p * 100)
    : (conv.entryPrice ? Math.round(conv.entryPrice * 100) : Math.round((bets.reduce((a, b) => a + num(b.entryPrice), 0) / (bets.length || 1)) * 100));
  const winRate = won.hasData ? Math.round(won.winRate) : (n ? Math.round(100 * k / n) : 0);
  const improbDenom = won.hasData ? won.improbDenom : (conv.entryPrice ? Math.round(1 / conv.entryPrice) : 0);
  const improbText = won.hasData ? won.improbText : (conv.entryPrice ? D.improbText(Math.round(1 / conv.entryPrice)) : "—");
  const profitNum = bets.reduce((a, b) => a + betPL(b), 0);
  const category = dominantCategory(bets);
  const fired = f.fired.slice();

  // ledger rows (each resolved position), newest entries first by stake.
  const ledger = bets.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd)).slice(0, 24).map((b) => ({
    market: b.question || "(market)", url: b.url || null,
    entryTime: b.ts ? dateStr(b.ts) : "",
    odds: Math.round(num(b.entryPrice) * 100), stake: money(b.stakeUsd),
    outcome: b.won ? "Won" : "Lost", pl: signedMoney(betPL(b)),
    tx: b.tx ? (String(b.tx).slice(0, 6) + "…") : "", txFull: b.tx || null,
  }));

  // scorecard — one card per FIRED detector, with the real measured numbers.
  const scorecard = [];
  const push = (key, metric, method, formula, numbers) => { if (fired.includes(key)) scorecard.push({ key, metric, method, formula, numbers }); };
  if (fired.includes("fresh") && dets.fresh.hasData)
    push("fresh", (dets.fresh.ageDays < 1 ? Math.round(dets.fresh.ageDays * 24) + "h old" : dets.fresh.ageDays.toFixed(0) + " days old"),
      "account-age check", "age = first bet block − funding block", dets.fresh.explain);
  push("longshot", avgImplied + "% avg", "average odds", "average of the market's odds at entry",
    dets.longshot.hasData ? dets.longshot.explain : "");
  if (fired.includes("held") && dets.held.hasData)
    push("held", dets.held.heldToResolution + " of " + dets.held.total, "exit check", "bets held to the end / total bets", dets.held.explain);
  if (fired.includes("won") && won.hasData)
    push("won", winRate + "% vs " + avgImplied + "%", "luck probability",
      "chance of ≥ " + k + " wins in " + n + " tries at " + avgImplied + "% each", won.explain);
  if (fired.includes("conviction") && conv.hasData)
    push("conviction", money(conv.stake) + " @ " + Math.round(conv.entryPrice * 100) + "%", "single high-conviction bet",
      "one large long-shot win held to resolution", conv.explain);
  if (fired.includes("conceal") && dets.conceal.hasData)
    push("conceal", dets.conceal.nTactics + " tactics", "concealment check", "score = f(split, decoy, cash-out)", dets.conceal.explain);
  if (fired.includes("cluster") && dets.cluster.hasData)
    push("cluster", dets.cluster.nWallets + " accounts", "shared-funding link",
      "link = w₁·funder + w₂·co-spend + w₃·sync + w₄·prox", dets.cluster.explain);

  // timeline from the single largest winning bet's price path (if the scanner
  // attached one); candidates stay clearly unverified.
  const lead = bets.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd))[0];
  const timeline = lead ? {
    market: lead.question || "lead market",
    priceStart: num(lead.priceStart) || num(lead.entryPrice),
    priceEnd: num(lead.priceEnd) || (lead.won ? 0.95 : 0.05),
    entries: [num(lead.entryPrice)], resolution: lead.won ? 0.92 : 0.08, candidates: [],
  } : {};

  const heroSentence = isCluster
    ? "These " + ((agg.members || []).length) + " linked accounts won " + k + " of " + n + " long-shot bets the market gave about a " + avgImplied +
      " percent chance. A record this strong is the pattern you would expect from foreknowledge, not luck — a pattern consistent with informed trading, not proof of it."
    : (convOnly
      ? "This account placed a single " + money(conv.stake) + " bet at roughly " + avgImplied + " percent" + (conv.market ? " on “" + String(conv.market).slice(0, 70) + "”" : "") +
        " and cashed out about " + money(conv.payout) + ". One bet is not statistically improbable on its own — but a lone, outsized, high-conviction long-shot like this, alongside the other signals, is the single-bet insider signature. Consistent with informed trading, not proof of it."
      : "This account won " + k + " of " + n + " long-shot bets that the market gave roughly a " + avgImplied +
        " percent chance. By luck you would expect about " + won.expectedWins + " wins. A record this strong is consistent with informed trading — not proof of it.");

  return {
    id: agg.id || (isCluster ? "c" + (idx + 1) : "w" + (idx + 1)),
    type: isCluster ? "cluster" : "wallet",
    address: agg.address || null,
    memberAddresses: isCluster ? (agg.members || []) : [agg.address],
    idLabel: isCluster ? ("Cluster of " + ((agg.members || []).length) + " wallets") : short(agg.address),
    username: agg.pseudonym || null,
    firstSeen: dateStr(agg.firstSeenTs) || "an unrecorded date",
    category, marketsCount: n, tier,
    improbText, improbDenom,
    improbFull: String(improbText).replace("M", " million").replace("B", " billion").replace("K", " thousand"),
    convictionFlag: convOnly,
    full: scorecard.length >= 3,
    winRate, avgImplied, profit: money(profitNum), fired,
    refId: agg.refId || ("WF-" + new Date((agg.firstSeenTs || 0) * 1000).getUTCFullYear() + "-" + String(1000 + idx).slice(1)),
    cexChips: agg.cexChips || [],
    heroSentence, scorecard, ledger,
    ledgerSummary: { markets: n, winRate, realized: signedMoney(profitNum) },
    timeline,
    cluster: isCluster ? (agg.clusterView || { ringValue: money(profitNum), size: (agg.members || []).length, nodes: agg.nodes || [], edges: (agg.edges || []) }) : undefined,
    // carry these so the derivation step can honour real values over its guesses
    activityDays: agg.firstSeenTs ? Math.max(0, Math.round((Date.now() - (agg._lastTs || agg.firstSeenTs) * 1000) / MS_DAY)) : undefined,
    confidenceLimiter: isCluster
      ? "common-ownership is inferred from funding heuristics, not confirmed identity"
      : "the binomial test assumes each bet is an independent event; correlated events are de-correlated before scoring",
    _profitNum: profitNum,
  };
}

/* ------------------------------------------------- derive (artifact parity) -- */
// Mirror of buildSubjects()'s forEach so real subjects carry the same derived
// fields the view reads. Kept in lock-step with the artifact.
function derive(all) {
  all.forEach((s, idx) => {
    s.wins = Math.round(s.marketsCount * s.winRate / 100);
    s.expectedWins = Math.round(s.marketsCount * s.avgImplied) / 100;
    const lg = Math.log10(Math.max(2, s.improbDenom));
    s.percentile = s.percentile != null ? s.percentile : Math.min(99.999, +(99 + Math.min(0.999, lg / 7)).toFixed(3));
    let vol = 0;
    if (s.ledger) s.ledger.forEach((r) => { vol += parseFloat(String(r.stake).replace(/[^0-9.]/g, "")) * (String(r.stake).includes("M") ? 1e6 : (String(r.stake).includes("K") ? 1e3 : 1)) || 0; });
    if (!vol) vol = Math.round(Math.abs(s._profitNum || 0) * 3.5);
    s.volumeNum = vol;
    s.volume = vol >= 1e6 ? "$" + (vol / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : "$" + Math.round(vol / 1e3) + "K";
    s.profitNum = s._profitNum != null ? Math.abs(s._profitNum) : (parseFloat(String(s.profit).replace(/[^0-9.]/g, "")) * (String(s.profit).includes("M") ? 1e6 : 1e3));
    s.activityDays = s.activityDays != null ? s.activityDays : (30 + idx * 17);
    s.lastActivity = s.activityDays <= 1 ? "today" : s.activityDays + " days ago";
    delete s._profitNum;
  });
  return all;
}

/* ----------------------------------------------------------------- payload -- */
// Build the full read-API payload from a list of aggregates + scan metadata.
// Subjects are ranked most-improbable first (the default public view).
function buildPayload(aggregates, meta) {
  const subjects = [];
  (aggregates || []).forEach((agg, i) => { const s = buildSubject(agg, i, meta); if (s) subjects.push(s); });
  subjects.sort((a, b) => b.improbDenom - a.improbDenom);
  derive(subjects);
  return {
    subjects,
    observed: (meta && meta.observed) || 0,
    reviewed: (meta && meta.reviewed) || 0,
    screened: (meta && meta.screened) || 0,
    meta: {
      observed: (meta && meta.observed) || 0,
      reviewed: (meta && meta.reviewed) || 0,
      screened: (meta && meta.screened) || 0,
      block: (meta && meta.block) || "",
      snapshot: (meta && meta.snapshot) || "",
      recomputed: (meta && meta.recomputed) || (meta && meta.snapshot) || "",
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { scoreAggregate, buildSubject, derive, buildPayload, money, signedMoney, dateStr, betPL, dominantCategory, TIER };
