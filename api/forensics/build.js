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
// Suspicious-Trades (Harvard episode) gates: a surveillance tool flags MATERIAL money made
// AGAINST the odds. A $20 win isn't worth investigating; a near-certain favorite carries no
// informational edge. So an episode must clear a real profit floor AND not be a heavy favorite.
// SOFTENED (7-case review): profit SIZE is no longer a hard gate (it isn't predictive — flagged
// stakes in the cases ran $500–$1.15M); only a light materiality floor remains so a $20 win isn't
// "investigated". The odds ceiling is the favorite ceiling (FAV_MAX_ODDS), shared with the favorite
// publish path, so the $40k-OpenAI-at-85% and GayPride-at-60–71% archetypes survive.
const HARVARD_MATERIAL_FLOOR = +process.env.HARVARD_MATERIAL_FLOOR || 250;   // light materiality floor ($)
// FAVORITE / cross-sectional PUBLISH path (folded into the ONE wallet store). This catches the
// favorite-odds insider the ≤35% long-shot binomial is structurally blind to (Harvard's Trump-2024
// archetype: bet a heavy favorite, simply out-profit everyone else). It is the SAME signal that
// blew up as the old "favorites pass" (mass false positives), so it is re-enabled ONLY behind the
// anti-FP gates we learned the hard way — every one of which must clear:
//   • the flagged episode WON and out-profited peers (z_profit_cross ≥ FAV_PROFIT_Z),
//   • it was an OUTSIZED bet (z_bet_cross ≥ 2 OR the wallet's sizing anomaly fires),
//   • entry odds are a FAVORITE but not a near-certainty (0 < p ≤ FAV_MAX_ODDS),
//   • the WALLET is NET PROFITABLE past FAV_MIN_NET_PROFIT (kills the net-losing whales the old
//     path waved through — out-profiting peers in ONE market while losing overall is not insider),
//   • ANTI-WHALE DISCRIMINATOR: ≥1 STRUCTURAL on-chain signal (fresh / concealed / clustered
//     wallet) corroborates. A bare whale on a favorite has none of these — that is what separates
//     an informed favorite bet from a smart whale we cannot distinguish without it.
const FAV_MIN_NET_PROFIT = +process.env.FAV_MIN_NET_PROFIT || 5000;   // wallet net realized P/L floor ($)
const FAV_MAX_ODDS = +process.env.FAV_MAX_ODDS || 0.90;              // entry-odds ceiling (favorite, not a sure thing)
const FAV_PROFIT_Z = +process.env.FAV_PROFIT_Z || 2;                 // z_profit_cross firing threshold
function scoreAggregate(agg) {
  const valid = (agg.bets || []).filter((b) => b && typeof b.won === "boolean" && D.isNum(num(b.entryPrice)));
  // CORRELATION KEY — collapse date-ladder / re-phrased variants of ONE event so the binomial
  // and cross-category tests count independent events, not correlated re-bets (see detectors.corrKey).
  valid.forEach((b) => { if (b.corrKey == null) b.corrKey = D.corrKey(b.question || b.market || null); });
  // The SUBJECT is the bettor's long-shot record: only bets entered at ≤35%
  // implied. Favorites aren't the anomaly and would dilute the binomial.
  const bets = valid.filter((b) => num(b.entryPrice) <= LONGSHOT_MAX);
  const betsForWon = bets.map((b) => ({ impliedProb: num(b.entryPrice), won: !!b.won, eventGroup: b.eventGroup, corrKey: b.corrKey, question: b.question }));
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

  // CROSS-CATEGORY ACCURACY: an improbability test over the FULL resolved record at ANY odds, so a
  // near-perfect MODERATE-odds serial winner (AlphaRaccoon 22/23, ricosuave 7/7) flags even with no
  // long-shot subset for the binomial to see.
  const crossCatD = D.crossCat(valid);
  // REPEAT-OFFENDER: early-and-right across multiple SEPARATE surprising events over time.
  const repeatD = D.repeat(valid);

  // CONCEALMENT — on-chain tactics + the rename/deletion proxy: a wallet with a real winning history
  // but NO public display name is consistent with an account scrubbed/anonymised after the fact.
  const _username = agg.pseudonym || (agg.profile && agg.profile.username) || null;
  const _anonymized = !_username && valid.filter((b) => b.won).length >= 3;
  const _concealIn = Object.assign({}, agg.conceal || {}, { anonymized: _anonymized });
  const concealD = (agg.conceal || _anonymized) ? D.concealment(_concealIn) : { key: "conceal", hasData: false };

  const clusterD = (agg.type === "cluster" && agg.edges)
    ? D.clusterScore(agg.edges, (agg.members || []).length) : { key: "cluster", hasData: false };

  // single high-conviction bet — the lone insider bet the binomial (n>=5) misses
  const convictionD = D.conviction(bets);
  // informed entry timing — bought cheap, right before the surprise it won (event-anchored to the
  // price-shock when the scanner attached one; falls back to resolution otherwise).
  const timingD = D.timing(bets);
  // directional/event concentration + within-trader bet-size anomaly — over the
  // FULL resolved record (portfolio properties, not just the long-shot subset).
  const concentrationD = D.concentration(valid);
  const sizingD = D.sizing(valid);

  const dets = { won: wonD, crossCat: crossCatD, longshot: longshotD, held: heldD, fresh: freshD, baseline: baselineD, profitCross: profitCrossD, conceal: concealD, cluster: clusterD, conviction: convictionD, timing: timingD, repeat: repeatD, concentration: concentrationD, sizing: sizingD };
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
    // SOFTENED gates (the 7-case review showed the old hard floors created false negatives — the
    // $40k OpenAI insider at 75–85% and the $500–$2k Iran cluster). harvardEpisode already RETAINS
    // only winning, outsized, out-profited episodes, so we only keep a light materiality floor and a
    // favorite-odds ceiling (a near-certainty carries no edge) — profit SIZE is no longer a gate.
    if (!(betPL(b) >= HARVARD_MATERIAL_FLOOR)) continue;
    if (!(num(b.entryPrice) > 0 && num(b.entryPrice) <= FAV_MAX_ODDS)) continue;
    const zw = sdW > 0 ? +(((num(b.stakeUsd) - muW) / sdW)).toFixed(3) : 0;
    const ep = D.harvardEpisode(Object.assign({}, b.hz, { zBetWithin: zw, won: b.won }));
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
  // ACCOUNT-LEVEL net loss: even with a profitable long-shot subset, a wallet whose ALL-TIME
  // Polymarket P/L is negative is not a credible insider — they lost money overall. Drop it when
  // the authoritative account P/L is known and ≤ 0. (Clusters pool members' P/L → exempt.)
  if (!isCluster && ctx.accountPL != null && ctx.accountPL <= 0) return "account net-negative (all-time P/L=$" + Math.round(ctx.accountPL) + ")";
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
  let tier = TIER[f.tier];
  if (!tier) return null;                                   // unflagged → not published
  const flaggedBy = "binomial";
  // question/url are dropped from STORED bets (re-derivable) to keep state.json small;
  // re-hydrate them from the resolved-market catalog (cond -> {q, s}) for display.
  const cat = catalog || (opts && opts.catalog) || {};
  // Hydrate the market NAME + LINK. A bet's own question/url can be a truthy PLACEHOLDER
  // ("(market)" / a generic ".../markets" link) when the source feed had no title — those must
  // NOT block the catalog lookup, so we treat them as empty. Link fallback order: real bet url →
  // catalog slug → the bet's eventGroup (which IS the event slug unless it's a 0x cond).
  const qOf = (b) => (b.question && b.question !== "(market)") ? b.question : ((cat[b.cond] && cat[b.cond].q) || "(market)");
  const urlOf = (b) => {
    if (b.url && !/\/markets\/?$/.test(b.url)) return b.url;
    if (cat[b.cond] && cat[b.cond].s) return "https://polymarket.com/event/" + cat[b.cond].s;
    if (b.eventGroup && !/^0x/.test(String(b.eventGroup))) return "https://polymarket.com/event/" + b.eventGroup;
    return null;
  };
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
  // PROFIT SIZE → TIER CAP, not exclusion (7-case review: profit size isn't predictive — flagged
  // stakes ran $500–$1.15M, and the Iran cluster cleared $500–$2k). We still require NET-POSITIVE
  // (validateSubject; informed trading is profitable), but a smaller realized profit no longer
  // DELETES a statistically-improbable wallet — it just caps it at the WATCH tier (a confidence
  // input). Material profit is needed to reach the elevated/extreme tiers. Clusters are exempt
  // (members split the position). Configurable via TIER_CONF_USD; default $5,000.
  const _tierConfUsd = +((opts && opts.tierConfUsd)) || +process.env.TIER_CONF_USD || 5000;
  if (agg.type !== "cluster" && profitNum > 0 && profitNum < _tierConfUsd && (tier === "extreme" || tier === "elevated")) {
    tier = "watch";
  }
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
      [["z_profit_cross", String(dets.profitCross.z)], ["market", dets.profitCross.market ? String(dets.profitCross.market).slice(0, 48) : "—"]]);

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
  // SOFTENED (7-case review): profit SIZE is no longer a hard exclusion — small-stake insiders are
  // documented (Iran cluster $500–$2k), so a low net-positive record is PUBLISHED (capped to the
  // watch tier above), not deleted. We keep only a tiny materiality floor so dust isn't flagged;
  // validateSubject still requires NET-POSITIVE P/L (informed trading is profitable). Clusters are
  // exempt (a bundle splits the position; the ring is the unit). Configurable via MIN_PROFIT_USD.
  const _minProfit = +((opts && opts.minProfitUsd)) || +process.env.MIN_PROFIT_USD || 1000;
  const _reason = validateSubject({ n, k, avgImplied, winRate, improbDenom, profitNum, bets, tier, won, conv, convOnly, isCluster, recordImprobable, minProfit: _minProfit, accountPL });
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
    // FLAG FAMILY — which test published this subject. Only "binomial-record" carries a true
    // binomial luck-probability (P = 1/improbDenom) drawn from the scored population, so the
    // Benjamini–Hochberg FDR control applies to that family ONLY; conviction (single-bet odds)
    // and clusters (a different unit) are exempt.
    flagFamily: isCluster ? "cluster" : (convOnly ? "conviction" : "binomial-record"),
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
    // DETECTOR AGREEMENT denominator = detectors that actually HAD DATA for this wallet (could fire),
    // NOT the full 12-detector roster. Most of the roster is archetype-/data-specific (cluster needs
    // a ring; conceal/fresh need on-chain enrichment; conviction is a different archetype) and is
    // EXCLUDED when it can't be measured — counting those as "failed to agree" makes a strong wallet
    // look weak ("4 of 12" when only ~7 were even measurable). The UI shows fired / measured.
    detectorsMeasured: Object.values(dets).filter((d) => d && d.hasData).length,
    detectorsFired: fired.length,
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
  // Hydrate the market NAME + LINK. A bet's own question/url can be a truthy PLACEHOLDER
  // ("(market)" / a generic ".../markets" link) when the source feed had no title — those must
  // NOT block the catalog lookup, so we treat them as empty. Link fallback order: real bet url →
  // catalog slug → the bet's eventGroup (which IS the event slug unless it's a 0x cond).
  const qOf = (b) => (b.question && b.question !== "(market)") ? b.question : ((cat[b.cond] && cat[b.cond].q) || "(market)");
  const urlOf = (b) => {
    if (b.url && !/\/markets\/?$/.test(b.url)) return b.url;
    if (cat[b.cond] && cat[b.cond].s) return "https://polymarket.com/event/" + cat[b.cond].s;
    if (b.eventGroup && !/^0x/.test(String(b.eventGroup))) return "https://polymarket.com/event/" + b.eventGroup;
    return null;
  };
  // Locate the anchor episode bet in the full record (match tx, else cond+ts) for its
  // AUTHORITATIVE per-position P/L (betPL → Polymarket cashPnl). This is the flagged profit.
  const anchor = valid.find((b) => (pc.tx && b.tx === pc.tx) || (pc.cond && b.cond === pc.cond && b.ts === pc.ts)) || null;
  if (!anchor) return null;
  // WON — informed trading is PROFITABLE. The flagged episode must actually have won; a big
  // bet that out-"profited" peers but lost is not the signature (and pollutes the view).
  if (anchor.won !== true) return null;
  // ODDS — a FAVORITE carries an edge worth investigating, a near-CERTAINTY does not. Require a
  // real entry price below the favorite ceiling (0 < p ≤ FAV_MAX_ODDS) so a whale parking money
  // on a 97% sure thing is not flagged as informed.
  if (!(num(anchor.entryPrice) > 0 && num(anchor.entryPrice) <= FAV_MAX_ODDS)) return null;
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
  // NET-PROFITABILITY (the gate the OLD favorites path lacked — and why it flagged net-losing
  // whales). Out-profiting peers in ONE market while LOSING money overall is not insider trading,
  // it's a gambler that got one win. Require the WALLET to be net-positive across its full resolved
  // record, past a real floor. This is what kills the documented mass false positives.
  const netPL = valid.reduce((a, b) => a + betPL(b), 0);
  if (!(netPL >= FAV_MIN_NET_PROFIT)) return null;
  // Corroborating detectors that ALSO fire on this wallet (shown as supporting cards).
  const corro = ["fresh", "conceal", "cluster", "sizing", "concentration", "timing", "baseline"]
    .filter((k) => dets[k] && dets[k].hasData && (k === "cluster" ? dets[k].isCluster : dets[k].fires));
  // ANTI-WHALE DISCRIMINATOR — the crux. A cross-sectional profit outlier on a favorite is, on its
  // own, indistinguishable from a smart whale we have no business accusing. What separates an
  // INFORMED favorite bet from a whale is on-chain STRUCTURE: concealment tactics or a coordinated
  // cluster. NOTE — `fresh` was REMOVED from this set after a live scan showed it fired on 75% of
  // wallets: Polymarket provisions a NEW PROXY WALLET PER USER at first deposit, so almost every
  // account looks "fresh" (new wallet, no prior tx, funded just before its first bet). It is NOT a
  // purpose-built-wallet signature here, so it can't be the anti-whale gate. Require concealment or
  // a funding cluster — genuinely hard to fake. sizing/concentration are whale-like and don't count.
  // On data without chain enrichment this flags few or none; that is correct — better to miss a
  // favorite-insider than to re-accuse a whale.
  const STRUCTURAL = ["conceal", "cluster"];
  const structural = corro.filter((k) => STRUCTURAL.includes(k));
  if (!structural.length) return null;
  // Tier from the cross-sectional profit z AND structural corroboration. "extreme" needs a strong
  // outlier (z≥4) plus ≥2 structural signals; a single structural signal caps at "high" — matching
  // the binomial path's ≥2-agreeing philosophy. There is no un-corroborated tier: structural ≥1 is
  // already required above, so every favorite flag carries the profit outlier AND on-chain structure.
  const z = pc.z;
  const sc2 = structural.length;
  const ftier = (z >= 4 && sc2 >= 2) ? "extreme"
    : (z >= 3 || sc2 >= 2) ? "high"
    : "notable";
  const tier = TIER[ftier];
  if (!tier) return null;
  const fired = ["profitCross"].concat(corro);
  const _prof = agg.profile || null;
  const accountPL = _prof && _prof.pnlAllTime != null && isFinite(num(_prof.pnlAllTime)) ? num(_prof.pnlAllTime) : null;
  if (accountPL != null && accountPL <= 0) return null;       // net-losing account → not an insider
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
      ["episode P/L", signedMoney(epPL)], ["wallet net P/L", signedMoney(netPL)]],
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

  // HARVARD CROSS-SECTIONAL SIGNALS — the flagged episode carries the SAME per-market cross-section
  // that powers the profit signal, so the other Harvard signals are measurable here too. Surface them
  // (bet vs the MARKET's other traders, late entry, one-sided conviction) so the favorites dossier
  // shows Harvard's full signal set, not just the profit outlier. Each is a real measured value on
  // this episode — shown when present; "fires" only when it clears Harvard's threshold.
  const hz = anchor.hz || {};
  const hxFired = [];
  if (D.isNum(hz.zBetCross)) {
    const zbc = +hz.zBetCross.toFixed(2);
    scorecard.push({ key: "hBetCross", metric: "z = " + zbc, method: "cross-sectional bet size (Harvard z_bet_cross)",
      formula: "z = (this bet − market mean stake) ÷ market SD, over the peers in the SAME market",
      numbers: "Staked " + zbc.toFixed(1) + " standard deviations more than the typical trader in this market" + (zbc >= 2 ? " — disproportionate capital on one outcome." : "."),
      inputs: [["z_bet_cross", String(zbc)], ["stake", money(epStake)]] });
    if (zbc >= 2) hxFired.push("hBetCross");
  }
  if (D.isNum(hz.lateBuyFraction)) {
    const late = Math.round(D.clip(hz.lateBuyFraction, 0, 1) * 100);
    scorecard.push({ key: "hLate", metric: late + "% late", method: "pre-event timing (Harvard late_buy_fraction)",
      formula: "share of this wallet's buy volume in the final 48h before resolution",
      numbers: late + "% of the buying landed in the final 48 hours before the market resolved" + (late >= 50 ? " — entering exactly when time-sensitive information is most valuable." : "."),
      inputs: [["late_buy_fraction", (hz.lateBuyFraction).toFixed(2)]] });
    if (late >= 50) hxFired.push("hLate");
  }
  if (D.isNum(hz.directionalScore)) {
    const dir = Math.round(D.clip(hz.directionalScore, 0, 1) * 100);
    scorecard.push({ key: "hDir", metric: dir + "% one-sided", method: "directional conviction (Harvard directional_score)",
      formula: "1 − sold/bought — one-sided, held to resolution without hedging",
      numbers: dir + "% one-directional (bought and held, not hedged)" + (dir >= 80 ? " — the un-hedged conviction of someone who already knows the answer." : "."),
      inputs: [["directional_score", (hz.directionalScore).toFixed(2)]] });
    if (dir >= 80) hxFired.push("hDir");
  }
  fired.push(...hxFired);

  // CONTRIBUTION split — each shown signal's share, proportional to its measured STRENGTH (so the
  // bar is honest about which signal is actually carrying the flag, across mixed units).
  const strength = {
    profitCross: D.clip(z / 8, 0, 1),
    hBetCross: D.isNum(hz.zBetCross) ? D.clip(hz.zBetCross / 8, 0, 1) : 0,
    sizing: dets.sizing && dets.sizing.hasData && dets.sizing.fires ? D.clip(dets.sizing.ratio / 20, 0.1, 1) : 0,
    hLate: D.isNum(hz.lateBuyFraction) ? D.clip(hz.lateBuyFraction, 0, 1) : 0,
    hDir: D.isNum(hz.directionalScore) ? D.clip(hz.directionalScore, 0, 1) : 0,
  };
  const shown = scorecard.map((c) => c.key);
  const contributions = {};
  let sSum = 0;
  shown.forEach((k) => { const v = strength[k] != null ? strength[k] : 0.45; sSum += v; });   // corroborators a fixed mid share
  shown.forEach((k) => { const v = strength[k] != null ? strength[k] : 0.45; contributions[k] = Math.round((v / (sSum || 1)) * 100); });

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
    // HEADLINE — an honest cross-sectional MARGIN, NOT a "1 in N". Trader-profit distributions are
    // heavy-tailed, so a normal-tail probability for a z of 4+ fabricates an astronomical figure;
    // we report only how many standard deviations above the market's other traders this wallet
    // profited. improbDenom is a SORT KEY (ranks favorites among themselves; far below the binomial
    // "1 in N" denoms, so cross-sectional flags rank beneath the statistically-improbable records).
    improbText: z.toFixed(1) + "σ over peers", improbDenom: Math.round(z * 100 + sc2 * 50),
    improbFull: "this wallet out-profited the other traders in that market by " + z.toFixed(1) + " standard deviations",
    improbCaption: "profit margin vs the market's other traders",
    percentile: D.clip(50 + z * 8 + sc2 * 4, 50, 99.5),
    convictionFlag: false, full: ledger.length >= 1, flagFamily: "favorite",
    winRate, avgImplied: epOdds, profit: signedMoney(epPL), fired, contributions, agreeing: fired.length,
    detectorsMeasured: Object.values(dets).filter((d) => d && d.hasData).length, detectorsFired: fired.length,
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

/* ------------------------------------------------ CROSS-CATEGORY subject -- */
// Publish the near-perfect MODERATE-odds serial winner the ≤35% long-shot binomial is structurally
// blind to (AlphaRaccoon 22/23, ricosuave 7/7). Flags on the FULL-record cross-category
// improbability (crossCat — a Poisson-binomial over mixed odds), CORROBORATED by ≥2 agreeing
// detectors and a net-positive record. crossCat yields a real "1 in N", so these rank naturally
// alongside the binomial subjects. Renders over the FULL resolved record. Returns null unless it
// qualifies. Same subject SHAPE as buildSubject so the UI renders it identically.
function buildCrossCatSubject(agg, idx, opts, catalog) {
  if (!agg || agg.type === "cluster") return null;
  const { dets, valid } = scoreAggregate(agg);
  const cc = dets.crossCat;
  if (!cc || !cc.hasData || !cc.fires) return null;
  // ≥2 INDEPENDENT agreeing detectors (excluding crossCat itself) — same corroboration philosophy
  // as the binomial path: a lone statistical signal needs independent agreement to flag.
  const AGREE = ["won", "longshot", "held", "fresh", "baseline", "profitCross", "conceal", "cluster", "conviction", "timing", "repeat", "concentration", "sizing"];
  const corro = AGREE.filter((k) => { const d = dets[k]; return d && d.hasData && (k === "cluster" ? d.isCluster : d.fires) && (D.isNum(d.score) ? d.score >= D.DEFAULTS.agreeSub : true); });
  if (corro.length < 2) return null;
  const netPL = valid.reduce((a, b) => a + betPL(b), 0);
  if (!(netPL > 0)) return null;                              // informed trading is profitable
  // MATERIALITY — crossCat previously skipped the money gate the binomial/favorites paths
  // enforce, so a statistically-odd record on trivial $5–40 stakes leaked into "notable". Apply
  // the SAME bar: a real amount AT RISK (total or single-event stake) AND a material flagged
  // profit. A lucky small gambler is not an insider — nobody risks exposure for a few hundred
  // dollars. (Clusters pool members' money and are handled by buildSubject.)
  const _stakeTotal = valid.reduce((a, b) => a + num(b.stakeUsd), 0);
  const _byEvent = {}; valid.forEach((b) => { const e = b.eventGroup || b.cond || b.question; _byEvent[e] = (_byEvent[e] || 0) + num(b.stakeUsd); });
  const _material = Math.max(_stakeTotal, Object.values(_byEvent).reduce((m, x) => Math.max(m, x), 0));
  const MATERIALITY_USD = +((opts && opts.materialityUsd)) || +process.env.MATERIALITY_USD || 1000;
  if (_material < MATERIALITY_USD) return null;               // immaterial stake → not published
  const MIN_FLAGGED = +((opts && opts.minProfitUsd)) || +process.env.MIN_PROFIT_USD || 1000;
  if (!(netPL >= MIN_FLAGGED)) return null;                   // trivial flagged profit → dropped
  // TIER capped at elevated — the normal-tail approximation is conservative in the extreme, so a
  // mixed-odds record is never "extreme" on this path alone (matches fuse()'s crossCat cap).
  const tier = cc.P <= D.DEFAULTS.pHigh ? "elevated" : "watch";
  const cat = catalog || (opts && opts.catalog) || {};
  const qOf = (b) => (b.question && b.question !== "(market)") ? b.question : ((cat[b.cond] && cat[b.cond].q) || "(market)");
  const urlOf = (b) => {
    if (b.url && !/\/markets\/?$/.test(b.url)) return b.url;
    if (cat[b.cond] && cat[b.cond].s) return "https://polymarket.com/event/" + cat[b.cond].s;
    if (b.eventGroup && !/^0x/.test(String(b.eventGroup))) return "https://polymarket.com/event/" + b.eventGroup;
    return null;
  };
  const _prof = agg.profile || null;
  const accountPL = _prof && _prof.pnlAllTime != null && isFinite(num(_prof.pnlAllTime)) ? num(_prof.pnlAllTime) : null;
  // NET-LOSING ACCOUNT — an insider profits; a wallet that LOST money all-time (e.g. −$23) that
  // happened to win a few small political long-shots is a lucky gambler, not informed. Drop it.
  if (accountPL != null && accountPL <= 0) return null;
  const wins = valid.filter((b) => b.won).length;
  const winRate = valid.length ? Math.round(100 * wins / valid.length) : 0;
  const ledger = valid.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd)).slice(0, 200).map((b) => ({
    market: qOf(b), url: urlOf(b), entryTime: b.ts ? dateStr(b.ts) : "", ts: b.ts || null,
    odds: Math.round(num(b.entryPrice) * 100), stakeNum: Math.round(num(b.stakeUsd)), plNum: Math.round(betPL(b)),
    stake: money(b.stakeUsd), outcome: b.won ? "Won" : "Lost", pl: signedMoney(betPL(b)),
    tx: b.tx ? (String(b.tx).slice(0, 6) + "…") : "", txFull: b.tx || null,
  }));
  if (!ledger.length) return null;
  // scorecard: the cross-category card first, then corroborating detectors' own cards.
  const scorecard = [{
    key: "crossCat", metric: cc.k + " of " + cc.n + " · " + cc.meanImplied + "%", method: "cross-category accuracy",
    formula: "Poisson-binomial: z = (wins − Σpᵢ) / √Σpᵢ(1−pᵢ) over ALL resolved bets at their own odds",
    numbers: cc.explain,
    inputs: [["n", String(cc.n) + " events"], ["k", String(cc.k) + " wins"], ["E[X]", cc.expectedWins + " expected"], ["z", String(cc.z)], ["P", cc.improbText]],
  }];
  const CARD = {
    timing: ["informed-entry timing", "winning bets bought right before the price-shock"],
    repeat: ["repeat-offender across events", "distinct surprising events won over time"],
    concentration: ["directional concentration", "max(YES, NO stake) ÷ total staked"],
    held: ["hold-to-resolution", "bets held to the end / total bets"],
    fresh: ["account-age check", "age = first bet block − funding block"],
    conceal: ["concealment check", "score = f(split, decoy, cash-out, anonymised profile)"],
    cluster: ["shared-funding link", "link = w₁·funder + w₂·co-spend + w₃·sync + w₄·prox"],
    sizing: ["within-trader bet-size anomaly", "largest event position ÷ this wallet's median bet"],
    profitCross: ["cross-sectional profit (Harvard z_profit_cross)", "z = (profit − market mean) ÷ market SD vs peers"],
    longshot: ["average odds", "average of the market's odds at entry"],
    baseline: ["win rate vs break-even", "realized win rate − payoff-implied break-even rate"],
    conviction: ["single high-conviction bet", "one large long-shot win held to resolution"],
  };
  corro.forEach((k) => { const d = dets[k]; const c = CARD[k]; if (!c) return;
    scorecard.push({ key: k, metric: (d.explain || "").slice(0, 0) || k, method: c[0], formula: c[1], numbers: d.explain || "", inputs: [] }); });
  const fired = ["crossCat"].concat(corro);
  // contribution split over the contribW weights, renormalised across the shown signals.
  const W = D.DEFAULTS.contribW; const contributions = {};
  const wsum = fired.reduce((a, k) => a + (W[k] || 6), 0) || 1;
  fired.forEach((k) => { contributions[k] = Math.round(((W[k] || 6) / wsum) * 100); });
  const lead = valid.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd))[0];
  const timeline = lead ? { market: qOf(lead), priceStart: num(lead.entryPrice), priceEnd: lead.won ? 0.95 : 0.05, entries: [num(lead.entryPrice)], resolution: lead.won ? 0.92 : 0.08, candidates: [] } : {};
  const heroSentence = "This account won " + cc.k + " of " + cc.n + " bets across markets the blended odds priced at about " + cc.meanImplied +
    " percent — roughly " + cc.expectedWins + " expected by luck (" + cc.z + " standard deviations above chance, about " + cc.improbText +
    "). A near-perfect record across diverse, moderate-odds markets is the cross-category signature the long-shot test cannot see. Consistent with informed trading — not proof of it.";
  return {
    id: "x" + (idx + 1), type: "wallet", address: agg.address || null, memberAddresses: [agg.address],
    idLabel: short(agg.address), username: agg.pseudonym || (_prof && _prof.username) || null,
    created: dateStr(agg.createdTs) || dateStr(agg.firstSeenTs) || "an unrecorded date", createdOnChain: agg.createdTs != null,
    firstSeen: dateStr(agg.firstSeenTs) || "an unrecorded date",
    category: dominantCategory(valid), marketsCount: cc.n, tier,
    improbText: cc.improbText, improbDenom: cc.improbDenom, improbFull: String(cc.improbText).replace("M", " million").replace("B", " billion").replace("K", " thousand"),
    improbCaption: "chance this cross-category record is luck",
    convictionFlag: false, full: ledger.length >= 1, flagFamily: "crossCat",
    winRate, avgImplied: cc.meanImplied, profit: money(netPL), fired, contributions, agreeing: corro.length,
    detectorsMeasured: Object.values(dets).filter((d) => d && d.hasData).length, detectorsFired: fired.length,
    refId: agg.refId || ("WF-X-" + String(1000 + idx).slice(1)), cexChips: agg.cexChips || [],
    heroSentence, scorecard, ledger,
    ledgerSummary: { markets: cc.n, winRate, realized: signedMoney(netPL) },
    timeline,
    activityDays: agg.firstSeenTs ? Math.max(0, Math.round((Date.now() - (agg._lastTs || agg.firstSeenTs) * 1000) / MS_DAY)) : undefined,
    confidenceLimiter: "the cross-category test uses a normal approximation over mixed odds; it ranks how improbable the record is, it does not prove intent",
    profitSource: "cross-category",
    flaggedBy: "cross-category",
    profitNum: Math.round(netPL), accountPnl: accountPL != null ? Math.round(accountPL) : null, accountPnlText: accountPL != null ? signedMoney(accountPL) : null,
    _profitNum: netPL, _profileVolume: _prof && _prof.volume != null && isFinite(num(_prof.volume)) ? num(_prof.volume) : null,
    _tradedCount: _prof && _prof.traded != null ? num(_prof.traded) : null,
  };
}

/* ------------------------------------------------ composite suspicion rank -- */
// DEFAULT RANKING. Pure binomial improbability answers "how unlikely is this exact win record by
// luck" — which is NOT the same as "how likely is this an insider". Ranking by it alone floated a
// small-money long-shot STREAK above a confirmed insider whose real signal was timing + magnitude
// (e.g. Magamyman: only "1 in 216", but +$218k and bought minutes before the news). The composite
// keeps improbability as the BACKBONE but also reflects corroboration breadth, pre-event timing,
// magnitude, and purpose-built structure — so a broadly-corroborated, well-timed, high-magnitude
// insider ranks where it belongs. Magnitude only RE-RANKS already-flagged wallets (the publish
// gates are unchanged), so it can't re-introduce the whale false positive. 0–100.
function suspicionScore(s) {
  const log10 = (x) => Math.log(Math.max(1, x)) / Math.LN10;
  // HARVARD-EPISODE subjects carry a composite score S in improbDenom — NOT a luck denominator —
  // so map S directly onto the 0..100 suspicion scale instead of the log10(1/P) path. Calibrated to
  // OUR retained-episode distribution (median S≈700, p90≈1370, p99≈1980 — far above the paper's raw
  // scale because we only retain the outsized-and-won tail): the divisor keeps the MEDIAN episode at
  // Notable and lifts only the top tail to High/Extreme, so the new per-episode flags don't all land
  // hot. Tunable via HARVARD_SUSPICION_DIV.
  if (s.profitSource === "harvard-episode") {
    const S = num(s.harvardScore != null ? s.harvardScore : s.improbDenom);
    const div = +process.env.HARVARD_SUSPICION_DIV || 22;            // S≈700→32 (Notable), ≈1370→62 (High), ≈1980→90 (Extreme)
    return Math.round(Math.max(20, Math.min(99, S / div)) * 10) / 10;
  }
  const fired = Array.isArray(s.fired) ? s.fired : [];
  const imp = Math.min(1, log10(s.improbDenom || 1) / 12);          // statistical improbability (validated backbone, saturates ~1e12)
  // CORROBORATION — how many independent red-flag tests fired. Scaled out to 9 (not 5) so that
  // MORE flags genuinely raises the score across the real 0–9 range we see: a wallet with 9/12
  // fired must never rank below one with 7/12, all else equal. The old /5 cap saturated at 5,
  // making 7 and 9 indistinguishable and letting bet-size break the tie the WRONG way.
  const breadth = Math.min(1, (s.detectorsFired || fired.length || s.agreeing || 0) / 9);
  const timingOn = fired.indexOf("timing") >= 0 || fired.indexOf("crossCat") >= 0 || fired.indexOf("newsBlackout") >= 0 ? 1 : 0; // pre-event timing / cross-category / news-blackout
  // purpose-built / coordinated structure. `fresh` is EXCLUDED — it fires on ~75% of Polymarket
  // wallets (per-user proxy wallets are inherently fresh), so it's a near-constant that discriminates
  // nothing; only concealment / funding-cluster are genuine structural tells.
  const structOn = (fired.indexOf("conceal") >= 0 || fired.indexOf("cluster") >= 0) ? 1 : 0;
  const mag = Math.min(1, log10(Math.abs(s.profitNum || 0)) / 6);   // realized magnitude (saturates ~$1M)
  // WEIGHTS — improbability + corroboration DOMINATE (the two things the card shows: "1 in N" and
  // "X/12 fired"), so the score is legible: more improbable and/or more flags ⇒ higher. Bet-size
  // (mag) is only a minor tiebreaker — it must NOT let a weak-improbability, fewer-flag whale
  // outrank a more-improbable, more-corroborated wallet (the old 0.20 mag weight did exactly that).
  const score = 0.42 * imp + 0.30 * breadth + 0.08 * timingOn + 0.14 * mag + 0.06 * structOn;
  return Math.round(score * 1000) / 10;                             // 0..100, one decimal
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
    const _signed = s.profitSource === "authoritative" || s.profitSource === "harvard-episode" || s.profitSource === "favorite-episode" || s.profitSource === "cross-category";
    s.profitNum = s._profitNum != null ? (_signed ? s._profitNum : Math.abs(s._profitNum)) : (parseFloat(String(s.profit).replace(/[^0-9.\-−]/g, "").replace("−", "-")) * (String(s.profit).includes("M") ? 1e6 : 1e3));
    s.activityDays = s.activityDays != null ? s.activityDays : (30 + idx * 17);
    s.lastActivity = s.activityDays <= 1 ? "today" : s.activityDays + " days ago";
    s.suspicion = suspicionScore(s);                          // composite default ranking (improbability + breadth + timing + magnitude + structure)
    // TIER ALIGNED TO THE GAUGE — the badge (Extreme / High / Notable) and the 0–100 suspicion
    // gauge must never disagree. Before, each publish path set its own tier, so a single big
    // "1 in 8" conviction bet read "High" next to a green 32 gauge while a 1-in-700 record read
    // "Notable" next to a yellow 63. Bin the FINAL tier from the suspicion score using the SAME
    // cutoffs as the gauge colour (≥72 → Extreme/red, ≥45 → High/amber, else Notable/green), so
    // a higher gauge always means an equal-or-hotter badge. (Publish GATES already ran on the
    // path tier above; this only re-labels what's shown + how it ranks/filters.)
    s.tier = s.suspicion >= 72 ? "extreme" : s.suspicion >= 45 ? "elevated" : "watch";
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
  // CONSERVATIVE PUBLISH FLOOR — the Harvard paper's own tier analysis shows the LOW tiers are
  // mostly false positives (the 0–200 band has a NEGATIVE aggregate P&L and a win rate barely above
  // the payoff break-even); only the upper tiers (their 200–500 / 500+, ~80% win rate) are enriched
  // for genuine informed trading. So by default we publish only our HIGH/EXTREME Harvard tiers and
  // hold back the weakest "notable" band. Set HARVARD_PUBLISH_NOTABLE=1 to widen later.
  if (process.env.HARVARD_PUBLISH_NOTABLE !== "1" && harvard.tier === "notable") return null;
  const cat = catalog || (opts && opts.catalog) || {};
  // Hydrate the market NAME + LINK. A bet's own question/url can be a truthy PLACEHOLDER
  // ("(market)" / a generic ".../markets" link) when the source feed had no title — those must
  // NOT block the catalog lookup, so we treat them as empty. Link fallback order: real bet url →
  // catalog slug → the bet's eventGroup (which IS the event slug unless it's a 0x cond).
  const qOf = (b) => (b.question && b.question !== "(market)") ? b.question : ((cat[b.cond] && cat[b.cond].q) || "(market)");
  const urlOf = (b) => {
    if (b.url && !/\/markets\/?$/.test(b.url)) return b.url;
    if (cat[b.cond] && cat[b.cond].s) return "https://polymarket.com/event/" + cat[b.cond].s;
    if (b.eventGroup && !/^0x/.test(String(b.eventGroup))) return "https://polymarket.com/event/" + b.eventGroup;
    return null;
  };
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
  // SAME money bar as the other single-wallet paths: a net-losing account or an immaterial
  // episode is not a credible insider even with a high composite (the edgeseekr-style guard).
  if (accountPL != null && accountPL <= 0) return null;
  const MATERIALITY_USD = +((opts && opts.materialityUsd)) || +process.env.MATERIALITY_USD || 1000;
  if (!(num(hb.stakeUsd) >= MATERIALITY_USD || Math.abs(epPL) >= MATERIALITY_USD)) return null;
  const wins = valid.filter((b) => b.won).length;
  const W = D.HARVARD_W;
  const z = (x) => (num(x)).toFixed(2);
  // 5 Harvard signal cards (UI renders these in the identical "what drove the flag" format).
  const sc = [
    { key: "hProfit", metric: "z = " + z(harvard.zProfitCross), method: "Cross-sectional profit", formula: "z = (profit − μ_market) / σ_market · weight " + W.profitCross,
      numbers: "profit " + z(harvard.zProfitCross) + " SD above the market's average trader", inputs: [["z_profit_cross", z(harvard.zProfitCross)], ["weight", String(W.profitCross)], ["+S", String(Math.round(W.profitCross * num(harvard.zProfitCross)))]] },
    { key: "hBetCross", metric: "z = " + z(harvard.zBetCross), method: "Cross-sectional bet size", formula: "z = (stake − μ_market) / σ_market · weight " + W.betCross,
      numbers: "bet " + z(harvard.zBetCross) + " SD above the market's average stake", inputs: [["z_bet_cross", z(harvard.zBetCross)], ["weight", String(W.betCross)], ["+S", String(Math.round(W.betCross * num(harvard.zBetCross)))]] },
    { key: "hBetWithin", metric: "z = " + z(harvard.zBetWithin), method: "Within-trader bet size", formula: "z = (stake − μ_wallet) / σ_wallet · weight " + W.betWithin,
      numbers: "bet " + z(harvard.zBetWithin) + " SD above this wallet's own typical stake", inputs: [["z_bet_within", z(harvard.zBetWithin)], ["weight", String(W.betWithin)], ["+S", String(Math.round(W.betWithin * num(harvard.zBetWithin)))]] },
    { key: "hLate", metric: Math.round(num(harvard.lateBuyFraction) * 100) + "% late", method: "Pre-event timing", formula: "late_buy_fraction (share of buys in the final 48h) · weight " + W.late,
      numbers: Math.round(num(harvard.lateBuyFraction) * 100) + "% of buying was in the final 48h before resolution", inputs: [["late_buy_fraction", num(harvard.lateBuyFraction).toFixed(2)], ["weight", String(W.late)], ["+S", String(Math.round(W.late * num(harvard.lateBuyFraction)))]] },
    { key: "hDir", metric: Math.round(num(harvard.directionalScore) * 100) + "% one-sided", method: "Directional concentration", formula: "directional_score (1 − sold/bought) · weight " + W.dir,
      numbers: Math.round(num(harvard.directionalScore) * 100) + "% one-directional (held, not hedged)", inputs: [["directional_score", num(harvard.directionalScore).toFixed(2)], ["weight", String(W.dir)], ["+S", String(Math.round(W.dir * num(harvard.directionalScore)))]] },
  ];
  // contribution split over ALL FIVE scored signals (profit/bet-cross/bet-within z's + late + dir),
  // normalised over the positive contributors. late/dir enter on [0,1] so their share is small —
  // exactly the paper's intended 15/10 weighting against the dominant z-spine.
  const rawC = { hProfit: W.profitCross * num(harvard.zProfitCross), hBetCross: W.betCross * num(harvard.zBetCross), hBetWithin: W.betWithin * num(harvard.zBetWithin), hLate: W.late * num(harvard.lateBuyFraction), hDir: W.dir * num(harvard.directionalScore) };
  const posSum = Object.values(rawC).reduce((a, v) => a + Math.max(0, v), 0) || 1;
  const contributions = {}; Object.keys(rawC).forEach((k) => { contributions[k] = Math.max(0, Math.round((Math.max(0, rawC[k]) / posSum) * 100)); });
  const lead = valid.slice().sort((a, b) => num(b.stakeUsd) - num(a.stakeUsd))[0];
  const timeline = lead ? { market: qOf(lead), priceStart: num(lead.entryPrice), priceEnd: lead.won ? 0.95 : 0.05, entries: [num(lead.entryPrice)], resolution: lead.won ? 0.92 : 0.08, candidates: [] } : {};
  const epOdds = Math.round(num(hb.entryPrice) * 100);
  const heroSentence = "This account's most anomalous (wallet, market) episode scores " + S + " on the Harvard composite — it bet " + money(hb.stakeUsd) + " at about " + epOdds + "% on “" + String(qOf(hb)).slice(0, 70) + "”" + (hb.won ? ", and won" : "") + ". The score combines all five signals — out-profiting the market, an outsized bet vs peers, an outsized bet vs its own norm, buying late (final 48h), and one-sided conviction — weighted as in Ofir & Ofir (profit/size dominate; timing and directionality are minor). We additionally retain only episodes that actually won and out-profited the market. Consistent with informed trading — not proof of it.";
  return {
    id: "h" + (idx + 1), type: "wallet", address: agg.address || null, memberAddresses: [agg.address],
    idLabel: short(agg.address), username: agg.pseudonym || (_prof && _prof.username) || null,
    created: dateStr(agg.createdTs) || dateStr(agg.firstSeenTs) || "an unrecorded date", createdOnChain: agg.createdTs != null,
    firstSeen: dateStr(agg.firstSeenTs) || "an unrecorded date",
    category: dominantCategory(valid), marketsCount: valid.length, tier, flagFamily: "harvard-episode",
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
  const marketsCovered = catalog ? Object.keys(catalog).length : 0;   // resolved markets scanned (the real coverage)
  return {
    model: "harvard", subjects,
    observed: (meta && meta.observed) || 0, reviewed: (meta && meta.reviewed) || 0, screened: (meta && meta.screened) || 0, scored: n,
    marketsCovered,
    totalFlaggedProfit: Math.round(totalFlaggedProfit), totalFlaggedProfitText: fmtUsd(totalFlaggedProfit),
    flaggedCount: n,
    meta: { observed: (meta && meta.observed) || 0, reviewed: (meta && meta.reviewed) || 0, screened: (meta && meta.screened) || 0, scored: n, snapshot: (meta && meta.snapshot) || "", recomputed: (meta && meta.recomputed) || "" },
    generatedAt: new Date().toISOString(),
  };
}

/* ----------------------------------------------------------------- payload -- */
// Benjamini–Hochberg FDR threshold. Given the p-values of EVERY test in a family (here: each
// scored wallet's binomial "this record is luck" probability) and a target false-discovery rate
// q, returns the largest p* such that calling everything with p ≤ p* "flagged" keeps the EXPECTED
// share of false flags ≤ q. As the number of wallets tested (m) grows, p* tightens automatically,
// so widening discovery never inflates the expected false-positive COUNT. Returns the input's max
// p when fewer than `minPop` tests exist (too small a family to correct — leave the fixed bar in
// place), and 0 when nothing clears.
function bhThreshold(pvals, q, minPop) {
  const m = pvals.length;
  if (!m || !(q > 0)) return 1;
  if (m < (minPop || 0)) return 1;                            // family too small to FDR-correct → don't tighten
  const sorted = pvals.slice().sort((a, b) => a - b);
  let pStar = 0;
  for (let i = 0; i < m; i++) { if (sorted[i] <= ((i + 1) / m) * q) pStar = sorted[i]; }  // largest k with P(k) ≤ (k/m)q
  return pStar;
}

// Build the full read-API payload from a list of aggregates + scan metadata.
// Subjects are ranked most-improbable first (the default public view).
function buildPayload(aggregates, meta, catalog) {
  const subjects = [];
  meta = meta || {};
  meta._scoredDenoms = [];                                     // every aggregate's improbability, for the true-rank percentile
  meta._harvardShadow = [];                                    // SHADOW: every wallet pure-Harvard WOULD flag this run (dark launch)
  (aggregates || []).forEach((agg, i) => { const s = buildSubject(agg, i, meta, catalog); if (s) subjects.push(s); });
  // FALSE-DISCOVERY-RATE CONTROL (binomial-record family). Testing thousands of wallets at a
  // fixed "1 in N" bar would, by chance alone, flag some — the multiple-comparisons problem. BH
  // computes an ADAPTIVE threshold over the full scored population so the EXPECTED fraction of
  // false flags stays ≤ q. We apply min(fixedBar, p*) — it can only TIGHTEN, never loosen, the
  // existing notable bar, so it strictly removes the weakest flags and never weakens a strong one.
  // Only the binomial-record family carries a true binomial p; conviction/cluster/crossCat/favorite
  // subjects (different quantities) are exempt and corrected on their own terms.
  const FDR_Q = +process.env.FDR_Q || 0.10;
  const FDR_MIN_POP = +process.env.FDR_MIN_POP || 500;        // need a real population before correcting
  const fdrPop = (meta._scoredDenoms || []).map((d) => 1 / Math.max(1, d));
  const pStar = bhThreshold(fdrPop, FDR_Q, FDR_MIN_POP);
  const fixedBar = D.DEFAULTS.pNotable;
  const fdrCut = Math.min(fixedBar, pStar);
  let fdrDropped = 0;
  for (let i = subjects.length - 1; i >= 0; i--) {
    const s = subjects[i];
    if (s.flagFamily !== "binomial-record") continue;
    const p = 1 / Math.max(1, s.improbDenom || 1);
    if (p > fdrCut) { subjects.splice(i, 1); fdrDropped++; }  // didn't survive multiple-testing correction
  }
  meta._fdr = { q: FDR_Q, pStar, fixedBar, effectiveCut: fdrCut, scored: fdrPop.length, droppedBinomial: fdrDropped };
  // FAVORITES / CROSS-SECTIONAL PASS — folds Harvard's favorite-odds archetype into this ONE wallet
  // store (option B: one source of truth, no separate "Suspicious Trades" view). It catches the
  // informed trader who bet a FAVORITE and simply out-profited the market — invisible to the ≤35%
  // long-shot binomial. This is the path that once produced mass false positives, so it is gated
  // HARD inside buildFavoriteSubject: the episode won + was outsized, the wallet is net-profitable
  // past a floor, AND ≥1 STRUCTURAL on-chain signal (fresh/concealed/clustered) corroborates — which
  // a bare net-losing whale cannot satisfy. Only wallets NOT already published by the binomial path
  // are considered (dedup by address), so every wallet appears at most once in the single store.
  const published = new Set();
  subjects.forEach((s) => (s.memberAddresses || [s.address]).forEach((a) => a && published.add(String(a).toLowerCase())));
  (aggregates || []).forEach((agg, i) => {
    if (!agg || agg.type === "cluster") return;
    const a = agg.address ? String(agg.address).toLowerCase() : null;
    if (a && published.has(a)) return;                          // already flagged by its long-shot record → don't double-list
    let s = null; try { s = buildFavoriteSubject(agg, subjects.length + i, meta, catalog); } catch (_) {}
    if (s) { subjects.push(s); if (a) published.add(a); }
  });
  // CROSS-CATEGORY PASS — the near-perfect MODERATE-odds serial winner (AlphaRaccoon, ricosuave) the
  // long-shot binomial can't see. Same dedup (each wallet at most once), folded into the one store.
  (aggregates || []).forEach((agg, i) => {
    if (!agg || agg.type === "cluster") return;
    const a = agg.address ? String(agg.address).toLowerCase() : null;
    if (a && published.has(a)) return;
    let s = null; try { s = buildCrossCatSubject(agg, subjects.length + i, meta, catalog); } catch (_) {}
    if (s) { subjects.push(s); if (a) published.add(a); }
  });
  // HARVARD PER-EPISODE PASS — the literature's primary unit. Insider trading is usually ONE
  // well-timed, outsized, profitable bet, NOT a long-shot career — exactly the (wallet, market)
  // episode the Harvard composite (Ofir & Ofir) scores. We compute it for every wallet already (it
  // drives harvardShadow); this PUBLISHES the episodes that clear the calibrated tier, gated the
  // same way as every other path (won + out-profited peers inside harvardEpisode; account
  // net-positive + material episode inside buildHarvardSubject). Dedup by address — a wallet
  // already flagged by an earlier path keeps that dossier. This is the pass that moves us from
  // "rare improbable careers" toward the per-episode scale the studies report.
  let harvardAdded = 0;
  (aggregates || []).forEach((agg, i) => {
    if (!agg || agg.type === "cluster") return;
    const a = agg.address ? String(agg.address).toLowerCase() : null;
    if (a && published.has(a)) return;
    let s = null; try { s = buildHarvardSubject(agg, subjects.length + i, meta, catalog); } catch (_) {}
    if (s) { subjects.push(s); if (a) published.add(a); harvardAdded++; }
  });
  meta._harvardPublished = harvardAdded;
  subjects.sort((a, b) => b.improbDenom - a.improbDenom);
  // TRUE-RANK PERCENTILE: rank each subject's improbability against the population of
  // wallets we actually SCORED this run (not the cheaply-screened "reviewed" count). The
  // percentile is the share of scored bettors strictly LESS improbable than this subject.
  const pop = (meta._scoredDenoms || []).slice().sort((a, b) => a - b);
  const scoredCount = pop.length;
  derive(subjects, pop);
  // DEFAULT ORDER = composite suspicion (improbability backbone + corroboration + timing + magnitude),
  // with improbability as the tiebreak. The read API still offers ?sort=improbability et al.
  subjects.sort((a, b) => (b.suspicion - a.suspicion) || (b.improbDenom - a.improbDenom));
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
      fdr: meta._fdr || null,                                  // multiple-testing control summary (q, threshold, dropped)
      block: (meta && meta.block) || "",
      snapshot: (meta && meta.snapshot) || "",
      recomputed: (meta && meta.recomputed) || (meta && meta.snapshot) || "",
    },
    generatedAt: new Date().toISOString(),
  };
}

/* ----------------------------------------------- info-environment enrichment -- */
// Attach the news-blackout / Federal-Register results to an already-published subject (the scanner
// does this post-scoring, bounded + deadline-gated, for the top flagged subjects only). These are
// CORROBORATORS: they add a fired key + a scorecard card and lift the composite suspicion (via the
// timing dimension), but they NEVER change the statistical tier (the flag decision). Non-destructive
// — existing contributions/tier are untouched; returns the subject for chaining.
function enrichInfoSignals(subject, nb, fr) {
  if (!subject) return subject;
  subject.fired = subject.fired || []; subject.scorecard = subject.scorecard || [];
  if (nb && nb.hasData && nb.fires) {
    if (!subject.fired.includes("newsBlackout")) subject.fired.push("newsBlackout");
    subject.scorecard.push({ key: "newsBlackout", metric: (nb.articleCount === 0 ? "news blackout" : nb.articleCount + " articles"),
      method: "pre-event news blackout (GDELT)", formula: "global news articles matching the market entity in the " + (nb.windowHours || 24) + "h before the bet",
      numbers: nb.explain, inputs: [["window", (nb.windowHours || 24) + "h pre-bet"], ["articles", String(nb.articleCount)]] });
  }
  if (fr && fr.hasData && fr.fires) {
    if (!subject.fired.includes("fedRegister")) subject.fired.push("fedRegister");
    const t = fr.top || {};
    // carry the actual filing so the dossier card can render a CLICKABLE link + the bet→filing timing.
    subject.fedRegisterDoc = { title: t.title || null, agency: t.agency || null, date: t.date || null, url: t.url || null, leadDays: t.leadDays != null ? t.leadDays : null };
    const inputs = [];
    if (t.leadDays != null && t.leadDays >= 0) inputs.push(["bet → filing", t.leadDays + "d before"]);
    if (t.date) inputs.push(["filing date", t.date]);
    if (t.agency) inputs.push(["agency", t.agency]);
    subject.scorecard.push({
      key: "fedRegister",
      metric: (t.leadDays != null && t.leadDays >= 0) ? (t.leadDays + "d before filing") : ((fr.nDocs || 0) + " reg doc" + ((fr.nDocs || 0) === 1 ? "" : "s")),
      method: "Federal Register match (regulatory-insider)",
      formula: "bet date vs publication date of a regulatory filing whose title names the market's entity",
      numbers: fr.explain, inputs, link: t.url || null, linkLabel: t.title ? ("↗ " + String(t.title).slice(0, 70)) : "↗ view the filing",
    });
  }
  subject.detectorsFired = subject.fired.length;
  subject.suspicion = suspicionScore(subject);                    // newsBlackout lifts the timing dimension
  return subject;
}

module.exports = { scoreAggregate, buildSubject, buildFavoriteSubject, buildCrossCatSubject, buildHarvardSubject, buildHarvardPayload, derive, buildPayload, suspicionScore, bhThreshold, enrichInfoSignals, money, signedMoney, dateStr, betPL, dominantCategory, validateSubject, TIER };
