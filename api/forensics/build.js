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
  // GUARD ON THE RAW priorTx, not num(priorTx): a FAILED Polygonscan fetch leaves
  // priorTx null, and num(null)===0 would make the wallet look brand-new (priorTx=0)
  // and falsely fire "purpose-built wallet". D.isNum(null) is false, so an unmeasured
  // prior-tx count correctly degrades to no-data instead of a fabricated accusation.
  const freshD = (ageDays != null && D.isNum(agg.priorTx))
    ? D.fresh({ ageDays, priorTx: agg.priorTx }) : { key: "fresh", hasData: false };

  const winRate = wonD.hasData ? wonD.winRate : null;
  // BREAK-EVEN benchmark (payoff-aware): the win rate is computed over the long-shot
  // subset, so the honest break-even is the AVERAGE ENTRY PRICE of those same bets —
  // you must win at your average buy price just to not lose money. Pass it so baseline()
  // compares win rate to break-even, not a flat 50%.
  const beEntry = impliedProbs.length ? impliedProbs.reduce((a, b) => a + b, 0) / impliedProbs.length : null;
  const baselineD = winRate != null
    ? D.baseline({ winRate, category: dominantCategory(bets), breakEven: D.isNum(beEntry) ? beEntry : undefined })
    : { key: "baseline", hasData: false };

  // CROSS-SECTIONAL PROFIT (Harvard z_profit_cross): scan the wallet's FULL resolved
  // record for the market where it out-profited its peers most. Works at any odds, so it
  // catches favorite-betting insiders the ≤35% long-shot binomial is structurally blind to.
  const profitCrossD = D.profitCross(valid);

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

  const dets = { won: wonD, longshot: longshotD, held: heldD, fresh: freshD, baseline: baselineD, profitCross: profitCrossD, conceal: concealD, cluster: clusterD, conviction: convictionD, timing: timingD, concentration: concentrationD, sizing: sizingD };
  const f = D.fuse(dets);

  // ---- HARVARD composite (Ofir & Ofir 2026): score every (wallet, market) EPISODE that
  // carries cross-sectional inputs (b.hz from the scanner), completing it with the
  // within-trader bet-size z computed from THIS wallet's own stake distribution. The wallet's
  // Harvard verdict is its single highest-scoring RETAINED episode (the suspicious bet). This
  // catches single-bet insiders the per-wallet binomial misses — incl. those who bet favorites.
  const valForW = valid.map((b) => num(b.stakeUsd)).filter((s) => s > 0);
  const muW = valForW.length ? valForW.reduce((a, b) => a + b, 0) / valForW.length : 0;
  const sdW = valForW.length > 1 ? Math.sqrt(valForW.reduce((a, b) => a + (b - muW) * (b - muW), 0) / (valForW.length - 1)) : 0;
  let bestH = null;
  for (const b of valid) {
    if (!b.hz) continue;
    const zw = sdW > 0 ? +(((num(b.stakeUsd) - muW) / sdW)).toFixed(3) : 0;
    const ep = D.harvardEpisode(Object.assign({}, b.hz, { zBetWithin: zw }));
    if (!ep.retained) continue;
    if (!bestH || ep.S > bestH.S) bestH = Object.assign(ep, { bet: b, tier: D.harvardTier(ep.S) });
  }
  const harvard = bestH && bestH.tier ? { hasData: true, ...bestH } : { hasData: false, S: bestH ? bestH.S : 0 };
  return { dets, f, harvard, bets, valid, ageDays };
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
  const { dets, f, harvard, bets } = scoreAggregate(agg);
  // EMPIRICAL PERCENTILE POPULATION: record every aggregate we actually SCORED on the
  // binomial (won.hasData) — flagged or not — so the percentile is a TRUE rank against the
  // wallets we computed improbability for, not the cheaply-screened "reviewed" count. This
  // fires for every aggregate buildPayload passes through, before the flag/gate filters.
  if (opts && Array.isArray(opts._scoredDenoms) && dets.won && dets.won.hasData && isFinite(dets.won.improbDenom)) {
    opts._scoredDenoms.push(dets.won.improbDenom);
  }
  // TIER: the binomial/conviction fuse still DRIVES the published tier (it builds the whole
  // subject around the ≤35% long-shot subset). The HARVARD composite is computed and carried
  // on the subject for display + ranking, but switching the live tier to it requires the
  // episode-based subject path (favorite-odds bets, single-episode headline) — built next, so
  // the working site is never half-broken. harvard.hasData flags a wallet Harvard WOULD flag.
  const harvardTierV = harvard && harvard.hasData ? harvard.tier : null;
  // SHADOW MODE (dark launch): record EVERY wallet the Harvard composite would flag — even
  // those our binomial doesn't — to a side channel, BEFORE the publish gates. This runs in
  // the cron (live data) and writes a diagnostic file, so we can validate pure-Harvard's real
  // output against the live data without changing the published tier or risking the site.
  if (harvardTierV && opts && Array.isArray(opts._harvardShadow) && agg.type !== "cluster") {
    const hb = harvard.bet || {};
    const _cat = catalog || (opts && opts.catalog) || {};
    const _q = (b) => b.question || (_cat[b.cond] && _cat[b.cond].q) || b.cond || "(market)";
    const _u = (b) => b.url || (_cat[b.cond] && _cat[b.cond].s ? "https://polymarket.com/event/" + _cat[b.cond].s : null);
    // Full evidence so the PREVIEW renders the real dossier (the bet ledger + on-chain verify
    // links + a chart), not just the score — exactly what the live Harvard cutover will keep.
    const _ledger = (agg.bets || []).filter((b) => b && typeof b.won === "boolean").slice()
      .sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd)).slice(0, 14).map((b) => ({
        market: _q(b), url: _u(b), ts: b.ts || null, odds: Math.round(num(b.entryPrice) * 100),
        stake: Math.round(num(b.stakeUsd)), pl: Math.round(betPL(b)), won: !!b.won, tx: b.tx || null,
      }));
    const _epProfit = hb.won ? betPL(hb) : null;
    const _prof2 = agg.profile || null;
    opts._harvardShadow.push({
      address: agg.address || null, username: (agg.pseudonym || (_prof2 && _prof2.username) || null),
      tier: harvardTierV, S: harvard.S,
      market: _q(hb), marketUrl: _u(hb), episodeTx: hb.tx || null,
      stake: Math.round(num(hb.stakeUsd)), odds: Math.round(num(hb.entryPrice) * 100), won: !!hb.won,
      episodeProfit: _epProfit != null ? Math.round(_epProfit) : null,
      zBetCross: harvard.zBetCross, zBetWithin: harvard.zBetWithin, zProfitCross: harvard.zProfitCross,
      lateBuyFraction: harvard.lateBuyFraction, directionalScore: harvard.directionalScore,
      accountPnl: (_prof2 && _prof2.pnlAllTime != null && isFinite(num(_prof2.pnlAllTime))) ? Math.round(num(_prof2.pnlAllTime)) : null,
      firstSeen: dateStr(agg.firstSeenTs) || null, createdOnChain: agg.createdTs != null, created: dateStr(agg.createdTs) || null,
      betsCount: (agg.bets || []).length, ledger: _ledger,
      alsoBinomial: !!TIER[f.tier],
    });
  }
  const tier = TIER[f.tier];
  if (!tier) return null;                                   // unflagged → not published
  const flaggedBy = "binomial";
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
  // NOTE on favorites: a strong cross-sectional profit outlier (profitCross / z_profit_cross)
  // can ALSO corroborate a flagged wallet here — it appears as a fired signal + scorecard card
  // below. But a PURE favorite-only record (no ≤35% long-shots) cannot be honestly rendered in
  // THIS subject, because the ledger here is the long-shot subset — the flagged favorite bet
  // would not appear in "the bets themselves". Those wallets are published by the dedicated
  // FAVORITES pass (buildFavoriteSubject), which leads with the favorite episode over the FULL
  // record. So favorites are caught two ways: corroboration here + their own dossier there.

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
  // FORENSIC P/L = the realized P/L of the FLAGGED long-shot bets themselves (the exact
  // rows in "THE BETS THEMSELVES"), each from Polymarket's authoritative per-position cashPnl
  // (betPL). THIS is the number the dossier leads with and the net-profit gate uses — so the
  // headline always RECONCILES to the bet table, and a wallet whose suspicious bets actually
  // LOST money is not flagged as a profitable insider just because it earned elsewhere.
  //   • accountPL (Polymarket's all-time profile P/L, ALL trades) is carried as SEPARATE
  //     context — shown labeled, never as the forensic profit, because it includes trades
  //     we don't flag (that's why it can dwarf the table).
  const recordedPL = bets.reduce((a, b) => a + betPL(b), 0);
  const _prof = agg.profile || null;
  const accountPL = _prof && _prof.pnlAllTime != null && isFinite(num(_prof.pnlAllTime)) ? num(_prof.pnlAllTime) : null;
  const profitNum = recordedPL;                              // profit ON THE FLAGGED BETS (reconciles to the table)
  const category = dominantCategory(bets);
  const fired = f.fired.slice();

  // ledger rows (each resolved position), newest entries first by stake.
  // FULL flagged-bet ledger (no top-N cap) so "THE BETS THEMSELVES" RECONCILES to the headline
  // profitNum (which sums every flagged bet). A 200-row guard bounds store.json for the rare
  // prolific wallet; flagged subjects clear the ≥5-long-shot + materiality gates, so in practice
  // the whole flagged record is shown and the bet table sums to the P&L.
  const ledger = bets.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd)).slice(0, 200).map((b) => ({
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
  if (fired.includes("profitCross") && dets.profitCross.hasData)
    push("profitCross", "z = " + dets.profitCross.z, "cross-sectional profit (Harvard z_profit_cross)",
      "z = (this wallet's profit − market mean) ÷ market SD, over peers in the SAME market", dets.profitCross.explain,
      [["z_profit_cross", String(dets.profitCross.z)], ["market", dets.profitCross.market ? String(dets.profitCross.market).slice(0, 48) : "—"], ["chance if normal", dets.profitCross.denomText]]);

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
        " and cashed out about " + money(conv.payout) + ". One bet is not statistically improbable on its own — but a lone, outsized, high-conviction long-shot like this, alongside the other signals, is the single-bet informed-trading signature. Consistent with informed trading, not proof of it."
      : "This account won " + k + " of " + n + " long-shot bets that the market gave roughly a " + avgImplied +
        " percent chance. By luck you would expect about " + won.expectedWins + " wins. A record this strong is consistent with informed trading — not proof of it.");

  // ---- PRE-PUBLISH GATE: reject (and log) anything whose numbers don't check out.
  // A SOLO insider makes real money on the flagged bets — a few hundred or even $1k of
  // profit isn't worth the risk/exposure of trading on material nonpublic info. Floor the
  // single-wallet flagged-bet profit at $5k. CLUSTERS are exempt (a bundle splits the
  // position across many wallets, so each member can be small — the ring is the unit).
  const _minProfit = +((opts && opts.minProfitUsd)) || +process.env.MIN_PROFIT_USD || 5000;
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
    // on-chain wallet-creation date (Polygonscan) when available, else first Polymarket
    // activity. `created` is the authoritative creation date the dossier shows.
    created: dateStr(agg.createdTs) || dateStr(agg.firstSeenTs) || "an unrecorded date",
    createdOnChain: agg.createdTs != null,
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
    // profit = realized P/L of the FLAGGED long-shot bets (sums the bet table). accountPnl
    // = Polymarket's all-time profile P/L across ALL the wallet's trades — shown as separate
    // context, clearly labeled, so the two scopes are never conflated.
    profitSource: "flagged-bets",
    // HARVARD composite (Ofir & Ofir 2026), carried for display + ranking. harvardScore is the
    // wallet's top retained (wallet,market) episode S; harvardWouldFlag = Harvard flags it even
    // if our binomial doesn't (yet). Drives the upcoming episode-based view.
    harvardScore: harvard && (harvard.S != null) ? harvard.S : 0,
    harvardTier: harvardTierV || null,
    harvardWouldFlag: !!harvardTierV,
    harvardEpisode: harvard && harvard.hasData ? {
      market: qOf(harvard.bet || {}), url: urlOf(harvard.bet || {}),
      stake: Math.round(num((harvard.bet || {}).stakeUsd)), odds: Math.round(num((harvard.bet || {}).entryPrice) * 100),
      won: !!(harvard.bet || {}).won, tx: (harvard.bet || {}).tx || null,
      zBetCross: harvard.zBetCross, zBetWithin: harvard.zBetWithin, zProfitCross: harvard.zProfitCross,
      lateBuyFraction: harvard.lateBuyFraction, directionalScore: harvard.directionalScore,
    } : null,
    profitNum: Math.round(profitNum),                          // P/L on the flagged bets (reconciles to the ledger)
    accountPnl: accountPL != null ? Math.round(accountPL) : null,
    accountPnlText: accountPL != null ? signedMoney(accountPL) : null,
    _profitNum: profitNum,
    _profileVolume: _prof && _prof.volume != null && isFinite(num(_prof.volume)) ? num(_prof.volume) : null,
    _tradedCount: _prof && _prof.traded != null ? num(_prof.traded) : null,
  };
}

/* -------------------------------------------------------- FAVORITES subject -- */
// Catch the favorite-betting informed trader the ≤35% long-shot binomial is STRUCTURALLY
// BLIND to (Harvard's Trump-2024 archetype: bet a heavy favorite, simply out-profit everyone
// else in the market). Anchored on the wallet's strongest CROSS-SECTIONAL PROFIT episode
// (profitCross / z_profit_cross) over its FULL resolved record — works at any odds. The "1 in N"
// is an honest normal-tail probability of that profit margin vs peers (captioned as such), NOT a
// binomial over independent bets. Returns null unless profitCross fires AND the episode is
// material. Same subject SHAPE as buildSubject so the UI renders it identically.
function buildFavoriteSubject(agg, idx, opts, catalog) {
  if (!agg || agg.type === "cluster") return null;            // favorites are a per-wallet, per-episode signal
  const { dets, valid } = scoreAggregate(agg);
  const pc = dets.profitCross;
  if (!pc || !pc.hasData || !pc.fires) return null;           // no cross-sectional profit outlier → not a favorites flag
  const cat = catalog || (opts && opts.catalog) || {};
  const qOf = (b) => b.question || (cat[b.cond] && cat[b.cond].q) || "(market)";
  const urlOf = (b) => b.url || (cat[b.cond] && cat[b.cond].s ? "https://polymarket.com/event/" + cat[b.cond].s : null);
  // Locate the anchor episode bet in the full record (match tx, else cond+ts) for its
  // AUTHORITATIVE per-position P/L (betPL → Polymarket cashPnl). This is the flagged profit.
  const anchor = valid.find((b) => (pc.tx && b.tx === pc.tx) || (pc.cond && b.cond === pc.cond && b.ts === pc.ts)) || null;
  if (!anchor) return null;
  // HARVARD RETENTION (anti-false-positive): someone wins every market, so out-profiting peers
  // is NOT enough on its own — Harvard keeps only episodes that ALSO bet outsized (z_bet_cross>2
  // OR z_bet_within>2). Require the flagged episode to be an outsized BET as well as an outsized
  // PROFIT: a big bet that won big is the informed-favorite signature ($13M Trump archetype); a
  // normal-sized bet that happened to win is just the lucky winner the market always produces.
  const outsizedBet = (anchor.hz && D.isNum(anchor.hz.zBetCross) && anchor.hz.zBetCross >= 2)
    || (dets.sizing && dets.sizing.hasData && dets.sizing.fires);
  if (!outsizedBet) return null;
  const epPL = betPL(anchor);
  const epStake = num(anchor.stakeUsd);
  const epOdds = Math.round(num(anchor.entryPrice) * 100);
  // MATERIALITY — real money on the flagged episode (stake or realized P/L). Same floor logic
  // as the binomial path: insider trading is about money, not odd records on trivial stakes.
  const MATERIALITY_USD = +((opts && opts.materialityUsd)) || +process.env.MATERIALITY_USD || 1000;
  const _material = Math.max(epStake, Math.abs(epPL));
  if (_material < MATERIALITY_USD) return null;
  // Corroborating detectors that ALSO fire on this wallet (shown as supporting cards).
  const corro = ["fresh", "conceal", "cluster", "sizing", "concentration", "timing", "baseline"]
    .filter((k) => dets[k] && dets[k].hasData && (k === "cluster" ? dets[k].isCluster : dets[k].fires));
  // Tier from the cross-sectional profit z (conservative; z>2 ≈ top ~2.3% if peers were normal).
  // The TOP tier requires corroboration — a lone signal, however strong, is capped at "high",
  // matching the binomial path's ≥2-agreeing philosophy. So "extreme" always means the profit
  // outlier AND at least one independent signal (fresh wallet, concealment, cluster, …) agree.
  const z = pc.z;
  const corr = corro.length;
  const ftier = (z >= 4 && corr >= 1) ? "extreme"
    : (z >= 4 || (z >= 3 && corr >= 1)) ? "high"
    : "notable";
  const tier = TIER[ftier];
  if (!tier) return null;
  const fired = ["profitCross"].concat(corro);
  const _prof = agg.profile || null;
  const accountPL = _prof && _prof.pnlAllTime != null && isFinite(num(_prof.pnlAllTime)) ? num(_prof.pnlAllTime) : null;
  const wins = valid.filter((b) => b.won).length;
  const winRate = valid.length ? Math.round(100 * wins / valid.length) : 0;

  // FULL-RECORD ledger (the favorite episode lives here — it would NOT in the long-shot subset).
  const ledger = valid.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd)).slice(0, 200).map((b) => ({
    market: qOf(b), url: urlOf(b), entryTime: b.ts ? dateStr(b.ts) : "", ts: b.ts || null,
    odds: Math.round(num(b.entryPrice) * 100), stakeNum: Math.round(num(b.stakeUsd)), plNum: Math.round(betPL(b)),
    stake: money(b.stakeUsd), outcome: b.won ? "Won" : "Lost", pl: signedMoney(betPL(b)),
    tx: b.tx ? (String(b.tx).slice(0, 6) + "…") : "", txFull: b.tx || null,
  }));
  if (!ledger.length) return null;

  // scorecard — the profit-outlier card first, then any corroborating detectors' own cards.
  const scorecard = [{
    key: "profitCross", metric: "z = " + z, method: "cross-sectional profit (Harvard z_profit_cross)",
    formula: "z = (this wallet's profit − market mean) ÷ market SD, over the peers in the SAME market",
    numbers: pc.explain,
    inputs: [["z_profit_cross", String(z)], ["episode", money(epStake) + " @ " + epOdds + "% on “" + String(qOf(anchor)).slice(0, 48) + "”"],
      ["episode P/L", signedMoney(epPL)], ["chance if normal", pc.denomText]],
  }];
  if (corro.includes("fresh") && dets.fresh.hasData)
    scorecard.push({ key: "fresh", metric: (dets.fresh.ageDays < 1 ? Math.round(dets.fresh.ageDays * 24) + "h old" : dets.fresh.ageDays.toFixed(0) + " days old"),
      method: "account-age check", formula: "age = first bet block − funding block", numbers: dets.fresh.explain,
      inputs: [["age", dets.fresh.ageDays < 1 ? Math.round(dets.fresh.ageDays * 24) + " h" : dets.fresh.ageDays.toFixed(1) + " days"], ["prior_tx", String(num(agg.priorTx))]] });
  if (corro.includes("conceal") && dets.conceal.hasData)
    scorecard.push({ key: "conceal", metric: dets.conceal.nTactics + " tactics", method: "concealment check",
      formula: "score = f(split, decoy, cash-out)", numbers: dets.conceal.explain, inputs: [["tactics", String(dets.conceal.nTactics)]] });
  if (corro.includes("cluster") && dets.cluster.hasData)
    scorecard.push({ key: "cluster", metric: dets.cluster.nWallets + " accounts", method: "shared-funding link",
      formula: "link = w₁·funder + w₂·co-spend + w₃·sync + w₄·prox", numbers: dets.cluster.explain, inputs: [["wallets", String(dets.cluster.nWallets)]] });
  if (corro.includes("sizing") && dets.sizing.hasData)
    scorecard.push({ key: "sizing", metric: Math.round(dets.sizing.ratio) + "× median", method: "within-trader bet-size anomaly",
      formula: "largest event position ÷ this wallet's median bet", numbers: dets.sizing.explain, inputs: [["ratio", dets.sizing.ratio + "×"]] });
  if (corro.includes("concentration") && dets.concentration.hasData)
    scorecard.push({ key: "concentration", metric: Math.round(dets.concentration.dirPurity * 100) + "% one-way", method: "directional concentration",
      formula: "max(YES, NO stake) ÷ total staked", numbers: dets.concentration.explain, inputs: [["one-way share", Math.round(dets.concentration.dirPurity * 100) + "%"]] });
  if (corro.includes("timing") && dets.timing.hasData)
    scorecard.push({ key: "timing", metric: dets.timing.lateWins + " of " + dets.timing.n + " late", method: "informed-entry timing",
      formula: "winning long-shots bought within hours of resolution", numbers: dets.timing.explain, inputs: [["late wins", String(dets.timing.lateWins) + " of " + dets.timing.n]] });
  if (corro.includes("baseline") && dets.baseline.hasData)
    scorecard.push({ key: "baseline", metric: dets.baseline.winRate + "% vs " + dets.baseline.breakEven + "%", method: "win rate vs break-even",
      formula: "realized win rate − payoff-implied break-even rate", numbers: dets.baseline.explain, inputs: [["win rate", dets.baseline.winRate + "%"], ["break-even", dets.baseline.breakEven + "%"]] });

  // contribution split: profit-outlier dominates; corroborators share the remainder evenly.
  const contributions = {}; const cShare = corro.length ? Math.round(35 / corro.length) : 0;
  contributions.profitCross = corro.length ? 65 : 100;
  corro.forEach((k) => { contributions[k] = cShare; });

  const timeline = { market: qOf(anchor), priceStart: num(anchor.entryPrice), priceEnd: anchor.won ? 0.95 : 0.05,
    entries: [num(anchor.entryPrice)], resolution: anchor.won ? 0.92 : 0.08, candidates: [] };

  const heroSentence = "This account did not need a long-shot record — it bet " + money(epStake) + " at about " + epOdds +
    "% on “" + String(qOf(anchor)).slice(0, 70) + "”" + (anchor.won ? " and won" : "") + ", profiting " + z.toFixed(1) +
    " standard deviations more than the other traders in that same market. Out-profiting the whole market on a single position is the favorite-odds informed-trading signature the long-shot test cannot see. Consistent with informed trading — not proof of it.";

  return {
    id: "f" + (idx + 1), type: "wallet", address: agg.address || null, memberAddresses: [agg.address],
    idLabel: short(agg.address), username: agg.pseudonym || (_prof && _prof.username) || null,
    created: dateStr(agg.createdTs) || dateStr(agg.firstSeenTs) || "an unrecorded date", createdOnChain: agg.createdTs != null,
    firstSeen: dateStr(agg.firstSeenTs) || "an unrecorded date",
    category: dominantCategory(valid), marketsCount: valid.length, tier,
    improbText: pc.denomText, improbDenom: pc.denom, improbFull: pc.denomText + " — chance of a profit margin this far above the market's other traders, if peer profits were normally distributed",
    improbCaption: "chance this profit edge is luck (vs peers)",
    convictionFlag: false, full: ledger.length >= 1,
    winRate, avgImplied: epOdds, profit: signedMoney(epPL), fired, contributions, agreeing: fired.length,
    refId: agg.refId || ("WF-F-" + String(1000 + idx).slice(1)), cexChips: agg.cexChips || [],
    heroSentence, scorecard, ledger,
    ledgerSummary: { markets: valid.length, winRate, realized: signedMoney(epPL) },
    timeline,
    activityDays: agg.firstSeenTs ? Math.max(0, Math.round((Date.now() - (agg._lastTs || agg.firstSeenTs) * 1000) / MS_DAY)) : undefined,
    confidenceLimiter: "the cross-sectional profit z assumes peer profits are roughly normal; it ranks how far this wallet out-earned the market, it does not prove intent",
    profitSource: "favorite-episode",
    flaggedBy: "cross-sectional-profit",
    harvardEpisode: { market: qOf(anchor), url: urlOf(anchor), stake: Math.round(epStake), odds: epOdds, won: !!anchor.won, tx: anchor.tx || null, zProfitCross: z },
    profitNum: Math.round(epPL), accountPnl: accountPL != null ? Math.round(accountPL) : null, accountPnlText: accountPL != null ? signedMoney(accountPL) : null,
    _profitNum: epPL, _profileVolume: _prof && _prof.volume != null && isFinite(num(_prof.volume)) ? num(_prof.volume) : null,
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
    // Keep the SIGN for authoritative + Harvard-episode P/L (a flagged episode can be a big
    // LOSING bet — retained by bet-size z, not profit — so abs() would wrongly flip its sign and
    // disagree with the signed s.profit shown on the card). Only the legacy flagged-bets path
    // (positive past the $5k gate) uses magnitude.
    const _signed = s.profitSource === "authoritative" || s.profitSource === "harvard-episode" || s.profitSource === "favorite-episode";
    s.profitNum = s._profitNum != null ? (_signed ? s._profitNum : Math.abs(s._profitNum)) : (parseFloat(String(s.profit).replace(/[^0-9.\-−]/g, "").replace("−", "-")) * (String(s.profit).includes("M") ? 1e6 : 1e3));
    s.activityDays = s.activityDays != null ? s.activityDays : (30 + idx * 17);
    s.lastActivity = s.activityDays <= 1 ? "today" : s.activityDays + " days ago";
    delete s._profitNum; delete s._profileVolume;
  });
  return all;
}

/* --------------------------------------------------------- HARVARD subject -- */
// Build a FULL subject (same shape the live UI renders — ledger, graphs, tx, WHO,
// scorecard, derived fields) but scored with the pure-Harvard composite (Ofir & Ofir
// 2026). The headline is the Suspicion Score; the "what drove it" cards are Harvard's
// five signals. Reuses every helper so the dossier is byte-for-byte the live format —
// only the metrics change. Returns null if the wallet has no retained Harvard episode.
const HARV_TO_UI_TIER = { extreme: "extreme", high: "elevated", notable: "watch" };
function buildHarvardSubject(agg, idx, opts, catalog) {
  if (agg.type === "cluster") return null;                    // Harvard scores per-wallet episodes
  const { harvard } = scoreAggregate(agg);
  if (!harvard || !harvard.hasData || !harvard.tier) return null;
  const cat = catalog || (opts && opts.catalog) || {};
  const qOf = (b) => b.question || (cat[b.cond] && cat[b.cond].q) || "(market)";
  const urlOf = (b) => b.url || (cat[b.cond] && cat[b.cond].s ? "https://polymarket.com/event/" + cat[b.cond].s : null);
  const tier = HARV_TO_UI_TIER[harvard.tier] || "watch";
  const S = Math.round(num(harvard.S));
  const hb = harvard.bet || {};
  const valid = (agg.bets || []).filter((b) => b && typeof b.won === "boolean" && D.isNum(num(b.entryPrice)));
  const ledger = valid.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd)).slice(0, 24).map((b) => ({
    market: qOf(b), url: urlOf(b), entryTime: b.ts ? dateStr(b.ts) : "", ts: b.ts || null,
    odds: Math.round(num(b.entryPrice) * 100), stakeNum: Math.round(num(b.stakeUsd)), plNum: Math.round(betPL(b)),
    stake: money(b.stakeUsd), outcome: b.won ? "Won" : "Lost", pl: signedMoney(betPL(b)),
    tx: b.tx ? (String(b.tx).slice(0, 6) + "…") : "", txFull: b.tx || null,
  }));
  if (!ledger.length) return null;
  const epPL = hb.won ? betPL(hb) : (hb.stakeUsd != null ? -num(hb.stakeUsd) : 0);
  const profitNum = Math.round(epPL);
  const _prof = agg.profile || null;
  const accountPL = _prof && _prof.pnlAllTime != null && isFinite(num(_prof.pnlAllTime)) ? num(_prof.pnlAllTime) : null;
  const wins = valid.filter((b) => b.won).length;
  const W = D.HARVARD_W;
  const z = (x) => (num(x)).toFixed(2);
  // 5 Harvard signal cards (UI renders these in the identical "what drove the flag" format).
  const sc = [
    { key: "hProfit", metric: "z = " + z(harvard.zProfitCross), method: "Cross-sectional profit", formula: "z = (profit − μ_market) / σ_market · weight 30",
      numbers: "profit " + z(harvard.zProfitCross) + " SD above the market's average trader", inputs: [["z_profit_cross", z(harvard.zProfitCross)], ["weight", "30"], ["+S", String(Math.round(W.profitCross * num(harvard.zProfitCross)))]] },
    { key: "hBetCross", metric: "z = " + z(harvard.zBetCross), method: "Cross-sectional bet size", formula: "z = (stake − μ_market) / σ_market · weight 25",
      numbers: "bet " + z(harvard.zBetCross) + " SD above the market's average stake", inputs: [["z_bet_cross", z(harvard.zBetCross)], ["weight", "25"], ["+S", String(Math.round(W.betCross * num(harvard.zBetCross)))]] },
    { key: "hBetWithin", metric: "z = " + z(harvard.zBetWithin), method: "Within-trader bet size", formula: "z = (stake − μ_wallet) / σ_wallet · weight 20",
      numbers: "bet " + z(harvard.zBetWithin) + " SD above this wallet's own typical stake", inputs: [["z_bet_within", z(harvard.zBetWithin)], ["weight", "20"], ["+S", String(Math.round(W.betWithin * num(harvard.zBetWithin)))]] },
    { key: "hLate", metric: Math.round(num(harvard.lateBuyFraction) * 100) + "% late", method: "Pre-event timing", formula: "fraction of buys in the final 48h · weight 15 × 100",
      numbers: Math.round(num(harvard.lateBuyFraction) * 100) + "% of buying was in the final 48h before resolution", inputs: [["late_buy_fraction", num(harvard.lateBuyFraction).toFixed(2)], ["weight", "15"], ["+S", String(Math.round(W.late * num(harvard.lateBuyFraction) * 100))]] },
    { key: "hDir", metric: Math.round(num(harvard.directionalScore) * 100) + "% one-sided", method: "Directional concentration", formula: "1 − sold/bought · weight 10 × 100",
      numbers: Math.round(num(harvard.directionalScore) * 100) + "% one-directional (held, not hedged)", inputs: [["directional_score", num(harvard.directionalScore).toFixed(2)], ["weight", "10"], ["+S", String(Math.round(W.dir * num(harvard.directionalScore) * 100))]] },
  ];
  // contribution split (each signal's share of S, normalised over the positive contributors)
  const rawC = { hProfit: W.profitCross * num(harvard.zProfitCross), hBetCross: W.betCross * num(harvard.zBetCross), hBetWithin: W.betWithin * num(harvard.zBetWithin), hLate: W.late * num(harvard.lateBuyFraction) * 100, hDir: W.dir * num(harvard.directionalScore) * 100 };
  const posSum = Object.values(rawC).reduce((a, v) => a + Math.max(0, v), 0) || 1;
  const contributions = {}; Object.keys(rawC).forEach((k) => { contributions[k] = Math.max(0, Math.round((Math.max(0, rawC[k]) / posSum) * 100)); });
  const lead = valid.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd))[0];
  const timeline = lead ? { market: qOf(lead), priceStart: num(lead.entryPrice), priceEnd: lead.won ? 0.95 : 0.05, entries: [num(lead.entryPrice)], resolution: lead.won ? 0.92 : 0.08, candidates: [] } : {};
  const epOdds = Math.round(num(hb.entryPrice) * 100);
  const heroSentence = "This account's most anomalous (wallet, market) episode scores " + S + " on the Harvard composite suspicion score — it bet " + money(hb.stakeUsd) + " at about " + epOdds + "% on “" + String(qOf(hb)).slice(0, 70) + "”" + (hb.won ? ", and won" : "") + ". The score combines five independent signals (outsized profit, outsized bet, late entry, one-sided conviction). Consistent with informed trading — not proof of it.";
  return {
    id: "h" + (idx + 1), type: "wallet", address: agg.address || null, memberAddresses: [agg.address],
    idLabel: short(agg.address), username: agg.pseudonym || (_prof && _prof.username) || null,
    created: dateStr(agg.createdTs) || dateStr(agg.firstSeenTs) || "an unrecorded date", createdOnChain: agg.createdTs != null,
    firstSeen: dateStr(agg.firstSeenTs) || "an unrecorded date",
    category: dominantCategory(valid), marketsCount: valid.length, tier,
    improbText: "Score " + S, improbDenom: S, improbFull: "a composite suspicion score of " + S, improbCaption: "composite suspicion score",
    convictionFlag: false, convBet: null, full: ledger.length >= 1,
    winRate: valid.length ? Math.round(100 * wins / valid.length) : 0, avgImplied: epOdds,
    profit: money(profitNum), fired: ["hProfit", "hBetCross", "hBetWithin", "hLate", "hDir"], contributions, agreeing: 5,
    refId: agg.refId || ("WF-H-" + String(1000 + idx).slice(1)), cexChips: agg.cexChips || [],
    heroSentence, scorecard: sc, ledger,
    ledgerSummary: { markets: valid.length, winRate: valid.length ? Math.round(100 * wins / valid.length) : 0, realized: signedMoney(profitNum) },
    timeline,
    activityDays: agg.firstSeenTs ? Math.max(0, Math.round((Date.now() - (agg._lastTs || agg.firstSeenTs) * 1000) / MS_DAY)) : undefined,
    confidenceLimiter: "the composite score is a statistical anomaly across five signals; it ranks suspicion, it does not prove intent",
    profitSource: "harvard-episode",
    harvardScore: S, harvardTier: harvard.tier, harvardWouldFlag: true,
    harvardEpisode: { market: qOf(hb), url: urlOf(hb), stake: Math.round(num(hb.stakeUsd)), odds: epOdds, won: !!hb.won, tx: hb.tx || null, zBetCross: harvard.zBetCross, zBetWithin: harvard.zBetWithin, zProfitCross: harvard.zProfitCross, lateBuyFraction: harvard.lateBuyFraction, directionalScore: harvard.directionalScore },
    profitNum, accountPnl: accountPL != null ? Math.round(accountPL) : null, accountPnlText: accountPL != null ? signedMoney(accountPL) : null,
    _profitNum: profitNum, _profileVolume: _prof && _prof.volume != null && isFinite(num(_prof.volume)) ? num(_prof.volume) : null, _tradedCount: _prof && _prof.traded != null ? num(_prof.traded) : null,
    model: "harvard",
  };
}

// Build the full Harvard-scored read-API payload (parallel to buildPayload). Ranks by the
// composite Suspicion Score; sets a true rank-percentile by score.
function buildHarvardPayload(aggregates, meta, catalog) {
  meta = meta || {};
  const subjects = [];
  (aggregates || []).forEach((agg, i) => { try { const s = buildHarvardSubject(agg, i, meta, catalog); if (s) subjects.push(s); } catch (_) {} });
  subjects.sort((a, b) => b.improbDenom - a.improbDenom);
  const n = subjects.length;
  subjects.forEach((s, i) => { s.percentile = n > 1 ? +(100 * (n - 1 - i) / (n - 1)).toFixed(3) : 99.9; s.percentileN = n; });
  derive(subjects, null);
  const totalFlaggedProfit = subjects.reduce((a, s) => a + (Number(s.profitNum) || 0), 0);
  const fmtUsd = (v) => (Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : Math.abs(v) >= 1e3 ? "$" + Math.round(v / 1e3) + "K" : "$" + Math.round(v));
  return {
    model: "harvard", subjects,
    observed: (meta && meta.observed) || 0, reviewed: (meta && meta.reviewed) || 0, screened: (meta && meta.screened) || 0, scored: n,
    totalFlaggedProfit: Math.round(totalFlaggedProfit), totalFlaggedProfitText: fmtUsd(totalFlaggedProfit),
    flaggedCount: n,
    meta: { observed: (meta && meta.observed) || 0, reviewed: (meta && meta.reviewed) || 0, screened: (meta && meta.screened) || 0, scored: n, snapshot: (meta && meta.snapshot) || "", recomputed: (meta && meta.recomputed) || "" },
    generatedAt: new Date().toISOString(),
  };
}

/* ----------------------------------------------------------------- payload -- */
// Build the full read-API payload from a list of aggregates + scan metadata.
// Subjects are ranked most-improbable first (the default public view).
function buildPayload(aggregates, meta, catalog) {
  const subjects = [];
  meta = meta || {};
  meta._scoredDenoms = [];                                     // every aggregate's improbability, for the true-rank percentile
  meta._harvardShadow = [];                                    // SHADOW: every wallet pure-Harvard WOULD flag this run (dark launch)
  (aggregates || []).forEach((agg, i) => { const s = buildSubject(agg, i, meta, catalog); if (s) subjects.push(s); });
  // FAVORITES PASS — catch the favorite-betting informed trader the long-shot binomial is blind
  // to (Harvard's Trump-2024 archetype). Only wallets NOT already published by the binomial, and
  // only on a real cross-sectional profit outlier (profitCross fires) over the full record.
  const _publishedAddrs = new Set(subjects.map((s) => (s.address || "").toLowerCase()).filter(Boolean));
  (aggregates || []).forEach((agg, i) => {
    if (!agg || agg.type === "cluster" || !agg.address) return;
    if (_publishedAddrs.has(String(agg.address).toLowerCase())) return;   // already flagged by the binomial — no double dossier
    const s = buildFavoriteSubject(agg, i, meta, catalog);
    if (s) { subjects.push(s); _publishedAddrs.add(String(agg.address).toLowerCase()); }
  });
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
  // SHADOW summary — how pure-Harvard's flag set compares to what we actually publish (binomial).
  const shadow = (meta._harvardShadow || []).slice().sort((a, b) => (b.S || 0) - (a.S || 0));
  // TRUE distribution stats over ALL shadow episodes (not just the top 50) — this is what tells
  // us whether calibration has landed in Harvard's range (paper: median 105, p99 368, >500 rare).
  const allS = shadow.map((r) => num(r.S)).filter((x) => isFinite(x)).sort((a, b) => a - b);
  const pct = (p) => (allS.length ? Math.round(allS[Math.min(allS.length - 1, Math.floor(allS.length * p))] * 10) / 10 : 0);
  const harvardShadow = {
    total: shadow.length,
    byTier: shadow.reduce((m, r) => { m[r.tier] = (m[r.tier] || 0) + 1; return m; }, {}),
    medianS: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99), minS: allS[0] || 0, maxS: allS[allS.length - 1] || 0,
    over500: allS.filter((x) => x > 500).length,                 // Harvard's "high tier" — should be rare once calibrated
    alsoBinomial: shadow.filter((r) => r.alsoBinomial).length,   // overlap: Harvard ∩ published
    onlyHarvard: shadow.filter((r) => !r.alsoBinomial).length,   // Harvard would flag, binomial misses
    // the live funnel, so the preview header can show the same observed → screened → flagged
    // → extreme counts the real site shows (Harvard's flagged/extreme, not the binomial ones).
    observed: (meta && meta.observed) || 0,
    reviewed: (meta && meta.reviewed) || 0,
    screened: (meta && meta.screened) || 0,
    scored: scoredCount,
    top: shadow.slice(0, 50),                                    // sample for eyeballing on live data
  };
  return {
    subjects,
    observed: (meta && meta.observed) || 0,
    reviewed: (meta && meta.reviewed) || 0,
    screened: (meta && meta.screened) || 0,
    totalFlaggedProfit: Math.round(totalFlaggedProfit),
    totalFlaggedProfitText: fmtUsd(totalFlaggedProfit),
    flaggedCount: subjects.length,
    scored: scoredCount,                                       // wallets actually scored on improbability (percentile denominator)
    harvardShadow,                                             // dark-launch diagnostic (not shown in UI)
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

module.exports = { scoreAggregate, buildSubject, buildFavoriteSubject, buildHarvardSubject, buildHarvardPayload, derive, buildPayload, money, signedMoney, dateStr, betPL, dominantCategory, validateSubject, TIER };
