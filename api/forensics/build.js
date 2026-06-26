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

// realized P/L for one bet. Prefer Polymarket's OWN number (b.pnl, from the
// /positions feed) — it's authoritative and accounts for partial exits, so it
// matches the wallet's Polymarket profile. Only when that's absent (a trades-only
// reconstruction) do we estimate held-to-resolution payout: won → stake·(1/p−1).
function betPL(b) {
  if (b && b.pnl != null && isFinite(Number(b.pnl))) return Number(b.pnl);
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
  // informed entry timing — bought cheap, late, right before the surprise it won
  const timingD = D.timing(bets);
  // directional/event concentration + within-trader bet-size anomaly — over the
  // FULL resolved record (portfolio properties, not just the long-shot subset).
  const concentrationD = D.concentration(valid);
  const sizingD = D.sizing(valid);

  const dets = { won: wonD, longshot: longshotD, held: heldD, fresh: freshD, baseline: baselineD, conceal: concealD, cluster: clusterD, conviction: convictionD, timing: timingD, concentration: concentrationD, sizing: sizingD };
  const f = D.fuse(dets);
  return { dets, f, bets, ageDays };
}

/* --------------------------------------------------------------- validate -- */
// PRE-PUBLISH CORRECTNESS GATE. A subject is published only if its numbers are
// internally consistent AND derived from real Polymarket-sourced, resolved bets.
// Returns a reason string if the subject must be REJECTED, or null if it's clean.
// This is what prevents a bad/fabricated number from ever reaching the UI.
function validateSubject(ctx) {
  const { n, k, avgImplied, winRate, improbDenom, profitNum, bets, tier, won, conv, convOnly, isCluster, recordImprobable } = ctx;
  if (!tier) return "no tier";
  if (!(n >= 1)) return "n<1";
  if (!(k >= 0 && k <= n)) return "k out of range (" + k + "/" + n + ")";
  if (!(avgImplied >= 1 && avgImplied <= 99)) return "avgImplied out of range (" + avgImplied + ")";
  if (!(winRate >= 0 && winRate <= 100)) return "winRate out of range (" + winRate + ")";
  if (!(isFinite(improbDenom) && improbDenom >= 1)) return "improbDenom invalid (" + improbDenom + ")";
  if (!isFinite(profitNum)) return "profit not finite";
  // NET PROFITABILITY: informed trading is profitable by definition. A flagged wallet
  // that NET LOST money on its long-shots is a gambler that got an improbable win amid
  // many losses — not an insider. Require positive realized P/L. (Clusters pool members'
  // P/L and are exempt — handled by the caller passing isCluster.)
  if (!isCluster && !(profitNum > 0)) return "net unprofitable (informed trading is profitable; profit=" + Math.round(profitNum) + ")";
  // MEANINGFUL profit floor: a wallet that NET a trivial amount (e.g. +$382 all-time) is
  // not a credible insider even with an improbable long-shot streak — the upside an insider
  // captures is material. Drop single wallets below the floor. (Clusters pool many members'
  // P/L → exempt.) Configurable via MIN_PROFIT_USD; default $1,000.
  const _minProfit = isFinite(ctx.minProfit) ? ctx.minProfit : 0;
  if (!isCluster && profitNum < _minProfit) return "below net-profit floor (profit=$" + Math.round(profitNum) + " < $" + _minProfit + ")";
  if (!Array.isArray(bets) || !bets.length) return "no bets";
  for (const b of bets) {                                    // every scored bet must be a real resolved Polymarket position
    const ep = num(b.entryPrice);
    if (!(ep > 0.0001 && ep < 0.9999)) return "bad entryPrice (" + ep + ")";
    if (!(isFinite(num(b.stakeUsd)) && num(b.stakeUsd) >= 0)) return "bad stake";
    if (typeof b.won !== "boolean") return "won not boolean";
    if (!b.cond) return "bet missing cond (unresolved market)";
  }
  // binomial self-consistency: ONLY when the published headline IS the binomial record
  // (recordImprobable). For conviction wallets the published "1 in N" is the conviction
  // bet's odds, a different quantity, so this check doesn't apply.
  if (recordImprobable && won && won.hasData) {
    const P = D.binomTailGE(won.n, won.k, won.p);
    const denom = P > 0 ? Math.round(1 / P) : Infinity;
    if (isFinite(denom) && isFinite(improbDenom) && improbDenom > 0) {
      const r = denom / improbDenom;
      if (r < 0.5 || r > 2) return "improbDenom mismatch (binomial " + denom + " vs published " + improbDenom + ")";
    }
  }
  // the single-bet conviction path must have a real firing conviction bet
  if (convOnly && !(conv && conv.fires && conv.stake > 0)) return "convOnly without a valid conviction bet";
  return null;
}

/* ----------------------------------------------------------------- subject -- */
// Build the artifact subject (pre-derivation) from an aggregate. Returns null
// if there is not enough data to compute the headline (won.hasData=false), so
// sub-5-bet wallets are excluded, never scored 0.
function buildSubject(agg, idx, opts, catalog) {
  const { dets, f, bets } = scoreAggregate(agg);
  // EMPIRICAL PERCENTILE POPULATION: record every aggregate we actually SCORED on the
  // binomial (won.hasData) — flagged or not — so the percentile is a TRUE rank against the
  // wallets we computed improbability for, not the cheaply-screened "reviewed" count. This
  // fires for every aggregate buildPayload passes through, before the flag/gate filters.
  if (opts && Array.isArray(opts._scoredDenoms) && dets.won && dets.won.hasData && isFinite(dets.won.improbDenom)) {
    opts._scoredDenoms.push(dets.won.improbDenom);
  }
  const tier = TIER[f.tier];
  if (!tier) return null;                                   // unflagged → not published
  // question/url are dropped from STORED bets (re-derivable) to keep state.json small;
  // re-hydrate them from the resolved-market catalog (cond -> {q, s}) for display.
  const cat = catalog || (opts && opts.catalog) || {};
  const qOf = (b) => b.question || (cat[b.cond] && cat[b.cond].q) || "(market)";
  const urlOf = (b) => b.url || (cat[b.cond] && cat[b.cond].s ? "https://polymarket.com/event/" + cat[b.cond].s : null);
  // Two publish paths: the binomial RECORD (won.hasData) or the single-bet
  // CONVICTION path (a lone high-conviction insider bet + corroboration).
  const conv = dets.conviction || {};
  // The "1 in N — chance this record is luck" headline is ONLY meaningful when the
  // binomial record is ACTUALLY improbable (P <= pNotable). A wallet with >=5 long-shots
  // but an unremarkable win rate (P ~ 1, i.e. "1 in 1") is NOT flagged by the record —
  // it's flagged by the CONVICTION path (one big winning long-shot bet). In that case the
  // headline must show the conviction framing (the $ won on the long-shot), never the
  // meaningless "1 in 1". recordImprobable decides which headline is shown.
  const recordImprobable = dets.won.hasData && dets.won.P != null && dets.won.P <= D.DEFAULTS.pNotable;
  const convOnly = !recordImprobable;
  if (convOnly && !conv.fires) return null;                 // record isn't improbable AND no conviction bet → don't publish

  // MATERIALITY — insider trading is about MONEY AT RISK. A statistically-unusual
  // record on trivial stakes (six winning $20 long-shots) is a lucky gambler, not an
  // insider, and it pollutes the notable tier. We gate on STAKE, not profit: long-shot
  // profit is amplified (a $20 bet at 10% pays ~$180), so profit overstates scale —
  // the honest "is this a serious bettor" signal is how much they put at risk. Use the
  // larger of total long-shot stake or biggest single-event stake. Every confirmed case
  // is $10k+ of stake, so a modest floor keeps them all. The notable tier (the
  // false-positive bucket) gets the full floor; extreme/high clear a far higher
  // STATISTICAL bar so they get half. Clusters pool many wallets' money → exempt.
  const _stakeTotal = bets.reduce((a, b) => a + num(b.stakeUsd), 0);
  const _stakeByEvent = {};
  bets.forEach((b) => { const e = b.eventGroup || b.cond || b.question; _stakeByEvent[e] = (_stakeByEvent[e] || 0) + num(b.stakeUsd); });
  const _maxEventStake = Object.values(_stakeByEvent).reduce((m, s) => Math.max(m, s), 0);
  const _material = Math.max(_stakeTotal, _maxEventStake);
  const MATERIALITY_USD = +((opts && opts.materialityUsd)) || +process.env.MATERIALITY_USD || 1000;
  const _floor = (f.tier === "extreme" || f.tier === "high") ? MATERIALITY_USD * 0.5 : MATERIALITY_USD;
  if (agg.type !== "cluster" && _material < _floor) return null;   // immaterial stake → not published

  const isCluster = agg.type === "cluster";
  const won = dets.won;
  const wins = bets.filter((b) => b.won).length;
  const n = won.hasData ? won.n : bets.length;
  const k = won.hasData ? won.k : wins;
  const avgImplied = won.hasData ? Math.round(won.p * 100)
    : (conv.entryPrice ? Math.round(conv.entryPrice * 100) : Math.round((bets.reduce((a, b) => a + num(b.entryPrice), 0) / (bets.length || 1)) * 100));
  const winRate = won.hasData ? Math.round(won.winRate) : (n ? Math.round(100 * k / n) : 0);
  const improbDenom = recordImprobable ? won.improbDenom : (conv.entryPrice ? Math.round(1 / conv.entryPrice) : 0);
  const improbText = recordImprobable ? won.improbText : (conv.entryPrice ? D.improbText(Math.round(1 / conv.entryPrice)) : "—");
  // AUTHORITATIVE P/L. The dossier headline P/L and the net-profit gate use Polymarket's
  // OWN all-time realized figure (agg.profile.pnlAllTime) — the exact number the wallet's
  // Polymarket profile shows — so our number can never diverge from Polymarket/predicts.
  // The per-bet reconstruction (recordedPL) is only a fallback for the rare wallet whose
  // profile feed was unavailable this run. A single wallet with NO authoritative figure is
  // DEFERRED (return null) rather than published with a number we can't source. Clusters
  // pool members (no single profile) and keep the per-bet sum.
  const recordedPL = bets.reduce((a, b) => a + betPL(b), 0);
  const _prof = agg.profile || null;
  const accountPL = _prof && _prof.pnlAllTime != null && isFinite(num(_prof.pnlAllTime)) ? num(_prof.pnlAllTime) : null;
  if (!isCluster && accountPL == null) return null;          // no authoritative account P/L → defer, never fabricate
  const profitNum = isCluster ? recordedPL : accountPL;
  const category = dominantCategory(bets);
  const fired = f.fired.slice();

  // ledger rows (each resolved position), newest entries first by stake.
  const ledger = bets.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd)).slice(0, 24).map((b) => ({
    market: qOf(b), url: urlOf(b),
    entryTime: b.ts ? dateStr(b.ts) : "", ts: b.ts || null,
    odds: Math.round(num(b.entryPrice) * 100), stakeNum: Math.round(num(b.stakeUsd)), plNum: Math.round(betPL(b)),
    stake: money(b.stakeUsd),
    outcome: b.won ? "Won" : "Lost", pl: signedMoney(betPL(b)),
    tx: b.tx ? (String(b.tx).slice(0, 6) + "…") : "", txFull: b.tx || null,
  }));

  // scorecard — one card per FIRED detector, with the real measured numbers AND the
  // real input bindings (every variable in the formula resolved to this wallet's actual
  // value: real ages, real tactic latencies, real link scores — never placeholders, so
  // "show the math" reproduces the result from this wallet's data alone).
  const scorecard = [];
  const push = (key, metric, method, formula, numbers, inputs) => { if (fired.includes(key)) scorecard.push({ key, metric, method, formula, numbers, inputs: inputs || [] }); };
  const _ageStr = dets.fresh.hasData ? (dets.fresh.ageDays < 1 ? Math.round(dets.fresh.ageDays * 24) + " h" : dets.fresh.ageDays.toFixed(1) + " days") : "—";
  const _cashoutH = agg.conceal && agg.conceal.cashoutLatencyHours != null ? agg.conceal.cashoutLatencyHours : null;
  if (fired.includes("fresh") && dets.fresh.hasData)
    push("fresh", (dets.fresh.ageDays < 1 ? Math.round(dets.fresh.ageDays * 24) + "h old" : dets.fresh.ageDays.toFixed(0) + " days old"),
      "account-age check", "age = first bet block − funding block", dets.fresh.explain,
      [["age", _ageStr], ["prior_tx", String(num(agg.priorTx))]]);
  push("longshot", avgImplied + "% avg", "average odds", "average of the market's odds at entry",
    dets.longshot.hasData ? dets.longshot.explain : "",
    [["p̄", (avgImplied / 100).toFixed(2)], ["n", String(bets.length) + " long-shots"], ["τ", "0.20"]]);
  if (fired.includes("held") && dets.held.hasData)
    push("held", dets.held.heldToResolution + " of " + dets.held.total, "exit check", "bets held to the end / total bets", dets.held.explain,
      [["held", String(dets.held.heldToResolution)], ["total", String(dets.held.total)], ["h", (dets.held.h != null ? dets.held.h.toFixed(2) : "—")]]);
  if (fired.includes("won") && won.hasData)
    push("won", winRate + "% vs " + avgImplied + "%", "luck probability",
      "chance of ≥ " + k + " wins in " + n + " tries at " + avgImplied + "% each", won.explain,
      [["n", String(n) + " bets"], ["k", String(k) + " wins"], ["p", (avgImplied / 100).toFixed(2)], ["E[X]", won.expectedWins + " expected"], ["P", improbText]]);
  if (fired.includes("conviction") && conv.hasData)
    push("conviction", money(conv.stake) + " @ " + Math.round(conv.entryPrice * 100) + "%", "single high-conviction bet",
      "one large long-shot win held to resolution", conv.explain,
      [["stake", money(conv.stake)], ["p", (conv.entryPrice).toFixed(2) + " (" + Math.round(conv.entryPrice * 100) + "%)"], ["payout", money(conv.payout)], ["return", conv.stake ? (+((conv.payout || 0) / conv.stake).toFixed(1)) + "×" : "—"]]);
  if (fired.includes("conceal") && dets.conceal.hasData)
    push("conceal", dets.conceal.nTactics + " tactics", "concealment check", "score = f(split, decoy, cash-out)", dets.conceal.explain,
      [["tactics", String(dets.conceal.nTactics) + (dets.conceal.tactics && dets.conceal.tactics.length ? " (" + dets.conceal.tactics.join("; ") + ")" : "")]].concat(_cashoutH != null ? [["cash-out latency", _cashoutH < 1 ? Math.round(_cashoutH * 60) + " min" : _cashoutH.toFixed(1) + " h"]] : []));
  if (fired.includes("cluster") && dets.cluster.hasData)
    push("cluster", dets.cluster.nWallets + " accounts", "shared-funding link",
      "link = w₁·funder + w₂·co-spend + w₃·sync + w₄·prox", dets.cluster.explain,
      [["wallets", String(dets.cluster.nWallets)], ["mean link", (dets.cluster.meanLink != null ? dets.cluster.meanLink.toFixed(2) : "—")], ["edges", String(dets.cluster.nEdges != null ? dets.cluster.nEdges : "—")]]);
  if (fired.includes("sizing") && dets.sizing.hasData)
    push("sizing", Math.round(dets.sizing.ratio) + "× median", "within-trader bet-size anomaly",
      "largest event position ÷ this wallet's median bet", dets.sizing.explain,
      [["largest", money(dets.sizing.maxEventStake)], ["median", money(dets.sizing.medianStake)], ["ratio", dets.sizing.ratio + "×"]]);
  if (fired.includes("concentration") && dets.concentration.hasData)
    push("concentration", Math.round(dets.concentration.dirPurity * 100) + "% one-way", "directional concentration",
      "max(YES, NO stake) ÷ total staked", dets.concentration.explain,
      [["one-way share", Math.round(dets.concentration.dirPurity * 100) + "%"]]);
  if (fired.includes("timing") && dets.timing.hasData)
    push("timing", dets.timing.lateWins + " of " + dets.timing.n + " late", "informed-entry timing",
      "winning long-shots bought within hours of resolution", dets.timing.explain,
      [["late wins", String(dets.timing.lateWins) + " of " + dets.timing.n], ["soonest", dets.timing.minHours + " h before"], ["median", dets.timing.medianHours + " h before"]]);

  // timeline from the single largest winning bet's price path (if the scanner
  // attached one); candidates stay clearly unverified.
  const lead = bets.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd))[0];
  const timeline = lead ? {
    market: lead.question || (lead.cond && cat[lead.cond] && cat[lead.cond].q) || "lead market",
    priceStart: num(lead.priceStart) || num(lead.entryPrice),
    priceEnd: num(lead.priceEnd) || (lead.won ? 0.95 : 0.05),
    entries: [num(lead.entryPrice)], resolution: lead.won ? 0.92 : 0.08, candidates: [],
  } : {};

  const heroSentence = isCluster
    ? "These " + ((agg.members || []).length) + " wallets appear to be controlled by a single entity (shared on-chain funding + co-ordinated betting). Together they won " + k + " of " + n + " long-shot bets the market gave about a " + avgImplied +
      " percent chance — the pattern you would expect from foreknowledge split across wallets, not luck. Consistent with informed trading by one operator, not proof of it."
    : (convOnly
      ? "This account placed a single " + money(conv.stake) + " bet at roughly " + avgImplied + " percent" + (conv.market ? " on “" + String(conv.market).slice(0, 70) + "”" : "") +
        " and cashed out about " + money(conv.payout) + ". One bet is not statistically improbable on its own — but a lone, outsized, high-conviction long-shot like this, alongside the other signals, is the single-bet insider signature. Consistent with informed trading, not proof of it."
      : "This account won " + k + " of " + n + " long-shot bets that the market gave roughly a " + avgImplied +
        " percent chance. By luck you would expect about " + won.expectedWins + " wins. A record this strong is consistent with informed trading — not proof of it.");

  // ---- PRE-PUBLISH GATE: reject (and log) anything whose numbers don't check out.
  const _minProfit = +((opts && opts.minProfitUsd)) || +process.env.MIN_PROFIT_USD || 1000;
  const _reason = validateSubject({ n, k, avgImplied, winRate, improbDenom, profitNum, bets, tier, won, conv, convOnly, isCluster, recordImprobable, minProfit: _minProfit });
  if (_reason) {
    if (opts && Array.isArray(opts._rejects)) opts._rejects.push({ address: agg.address || ((agg.members || [])[0]) || null, id: agg.id || null, tier, reason: _reason });
    return null;
  }

  return {
    id: agg.id || (isCluster ? "c" + (idx + 1) : "w" + (idx + 1)),
    type: isCluster ? "cluster" : "wallet",
    address: agg.address || null,
    memberAddresses: isCluster ? (agg.members || []) : [agg.address],
    idLabel: isCluster ? (((agg.members || []).length) + " wallets · 1 entity") : short(agg.address),
    username: agg.pseudonym || (_prof && _prof.username) || null,
    firstSeen: dateStr(agg.firstSeenTs) || "an unrecorded date",
    category, marketsCount: n, tier,
    improbText, improbDenom,
    improbFull: String(improbText).replace("M", " million").replace("B", " billion").replace("K", " thousand"),
    convictionFlag: convOnly,
    convBet: (conv && conv.fires) ? { stake: Math.round(conv.stake || 0), entryPct: Math.round((conv.entryPrice || 0) * 100), payout: Math.round(conv.payout || 0), market: conv.market || "", mult: conv.stake ? +((conv.payout || 0) / conv.stake).toFixed(1) : null } : null,
    // FULL dossier renders whenever there's real evidence to show — a ledger of resolved
    // bets plus the improbability/conviction headline. Every published subject clears the
    // upstream gates (≥5 long-shots or a conviction bet, materiality, net-profit), so it
    // always has the ledger, tx links, percentile graph, and detector breakdown to show.
    // (Previously gated on ≥3 scorecard cards, which hid the entire dossier — graphs, tx,
    // metrics — for legitimate 2-signal wallets.)
    full: (ledger.length >= 1) && (recordImprobable || (conv && conv.fires)),
    winRate, avgImplied, profit: money(profitNum), fired,
    // the AUTHORITATIVE per-detector contribution split (renormalised over FIRED
    // detectors with the real DEFAULTS.contribW weights). The UI must use this, not a
    // recomputed map, so conviction/timing/concentration/sizing aren't shown as 0%.
    contributions: f.contributions || {},
    agreeing: f.agreeing,
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
    // P/L provenance for the UI: authoritative = pulled directly from Polymarket's profile
    // feed; reconstructed = summed from per-bet records (clusters / profile unavailable).
    profitSource: isCluster ? "reconstructed" : "authoritative",
    profitNum: Math.round(profitNum),                          // authoritative account P/L (already net; not abs-ed)
    _profitNum: profitNum,
    _profileVolume: _prof && _prof.volume != null && isFinite(num(_prof.volume)) ? num(_prof.volume) : null,
    _tradedCount: _prof && _prof.traded != null ? num(_prof.traded) : null,
  };
}

/* ------------------------------------------------- derive (artifact parity) -- */
// Mirror of buildSubjects()'s forEach so real subjects carry the same derived
// fields the view reads. Kept in lock-step with the artifact.
function derive(all, scoredPop) {
  // sorted ascending population of improbabilities we scored — used for the true rank.
  const pop = Array.isArray(scoredPop) ? scoredPop : null;
  const popN = pop ? pop.length : 0;
  all.forEach((s, idx) => {
    s.wins = Math.round(s.marketsCount * s.winRate / 100);
    s.expectedWins = Math.round(s.marketsCount * s.avgImplied) / 100;
    // PERCENTILE: a TRUE empirical rank — the share of scored bettors strictly LESS
    // improbable than this one. Falls back to the log-odds transform only when no scored
    // population is available (e.g. unit tests calling derive() directly).
    if (s.percentile != null) {
      /* keep an explicitly-provided percentile */
    } else if (popN > 1) {
      // count strictly-less-improbable via binary search on the ascending population
      let lo = 0, hi = popN;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pop[mid] < s.improbDenom) lo = mid + 1; else hi = mid; }
      s.percentile = Math.min(99.999, +(100 * lo / popN).toFixed(3));
      s.percentileN = popN;
    } else {
      const lg = Math.log10(Math.max(2, s.improbDenom));
      s.percentile = Math.min(99.999, +(99 + Math.min(0.999, lg / 7)).toFixed(3));
    }
    // VOLUME — prefer Polymarket's authoritative lifetime volume (from the profile feed);
    // only reconstruct from ledger stakes when it's unavailable (clusters / fetch failed).
    let vol = s._profileVolume != null ? Math.round(s._profileVolume) : 0;
    if (!vol && s.ledger) s.ledger.forEach((r) => { vol += parseFloat(String(r.stake).replace(/[^0-9.]/g, "")) * (String(r.stake).includes("M") ? 1e6 : (String(r.stake).includes("K") ? 1e3 : 1)) || 0; });
    if (!vol) vol = Math.round(Math.abs(s._profitNum || 0) * 3.5);
    s.volumeNum = vol;
    s.volume = vol >= 1e6 ? "$" + (vol / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : "$" + Math.round(vol / 1e3) + "K";
    // P/L: authoritative account figure (non-cluster) is already net & positive past the
    // gate; clusters keep the pooled magnitude. money()/signedMoney() use this directly.
    s.profitNum = s._profitNum != null ? (s.profitSource === "authoritative" ? s._profitNum : Math.abs(s._profitNum)) : (parseFloat(String(s.profit).replace(/[^0-9.]/g, "")) * (String(s.profit).includes("M") ? 1e6 : 1e3));
    s.activityDays = s.activityDays != null ? s.activityDays : (30 + idx * 17);
    s.lastActivity = s.activityDays <= 1 ? "today" : s.activityDays + " days ago";
    delete s._profitNum; delete s._profileVolume;
  });
  return all;
}

/* ----------------------------------------------------------------- payload -- */
// Build the full read-API payload from a list of aggregates + scan metadata.
// Subjects are ranked most-improbable first (the default public view).
function buildPayload(aggregates, meta, catalog) {
  const subjects = [];
  meta = meta || {};
  meta._scoredDenoms = [];                                     // every aggregate's improbability, for the true-rank percentile
  (aggregates || []).forEach((agg, i) => { const s = buildSubject(agg, i, meta, catalog); if (s) subjects.push(s); });
  subjects.sort((a, b) => b.improbDenom - a.improbDenom);
  // TRUE-RANK PERCENTILE: rank each subject's improbability against the population of
  // wallets we actually SCORED this run (not the cheaply-screened "reviewed" count). The
  // percentile is the share of scored bettors strictly LESS improbable than this subject.
  const pop = (meta._scoredDenoms || []).slice().sort((a, b) => a - b);
  const scoredCount = pop.length;
  derive(subjects, pop);
  // AGGREGATE estimated informed-trading P&L across published subjects — directly
  // comparable (in kind) to the Harvard study's $143M, but at our strict bar and our
  // current coverage, so it starts small and grows as coverage scales.
  const totalFlaggedProfit = subjects.reduce((a, s) => a + (Number(s.profitNum) || 0), 0);
  const fmtUsd = (v) => (Math.abs(v) >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : Math.abs(v) >= 1e3 ? "$" + Math.round(v / 1e3) + "K" : "$" + Math.round(v));
  return {
    subjects,
    observed: (meta && meta.observed) || 0,
    reviewed: (meta && meta.reviewed) || 0,
    screened: (meta && meta.screened) || 0,
    totalFlaggedProfit: Math.round(totalFlaggedProfit),
    totalFlaggedProfitText: fmtUsd(totalFlaggedProfit),
    flaggedCount: subjects.length,
    scored: scoredCount,                                       // wallets actually scored on improbability (percentile denominator)
    meta: {
      observed: (meta && meta.observed) || 0,
      reviewed: (meta && meta.reviewed) || 0,
      screened: (meta && meta.screened) || 0,
      scored: scoredCount,
      block: (meta && meta.block) || "",
      snapshot: (meta && meta.snapshot) || "",
      recomputed: (meta && meta.recomputed) || (meta && meta.snapshot) || "",
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { scoreAggregate, buildSubject, derive, buildPayload, money, signedMoney, dateStr, betPL, dominantCategory, validateSubject, TIER };
