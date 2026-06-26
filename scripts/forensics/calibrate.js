"use strict";
// CALIBRATION against KNOWN insider wallets (the PolyBeats/DOJ Maduro-capture set).
// For each address it reconstructs the FULL record the scanner would build (live
// /trades + on-demand market resolution + /positions), runs the real scorer, and
// reports the tier + every detector's numbers + Polymarket's own P/L — so we can
// see exactly whether the engine catches each confirmed insider, and why/why not.
const poly = require("../../api/forensics/poly.js");
const build = require("../../api/forensics/build.js");
const chain = require("../../api/forensics/chain.js");

const ADDRS = (process.env.ADDRS || "0x6baf05d193692bb208d616709e27442c910a94c5")
  .split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };

async function recordFor(addr) {
  const utrades = await poly.userTrades(addr).catch(() => []);
  const conds = Array.from(new Set(utrades.map((t) => t.conditionId || t.market || t.condition_id).filter(Boolean)));
  let catalog = {};
  try { catalog = await poly.marketsByConds(conds, { maxConds: 400 }); } catch (_) {}
  const recBets = poly.buildUserRecord(utrades, catalog);
  let posBets = [];
  try { posBets = (await poly.userPositions(addr)).map(poly.positionToBet).filter(Boolean); } catch (_) {}
  const byCond = {};
  posBets.forEach((b) => { byCond[b.cond] = b; });
  recBets.forEach((b) => { if (!byCond[b.cond]) byCond[b.cond] = b; });
  return { bets: Object.values(byCond), trades: utrades.length, cataloged: Object.keys(catalog).length };
}

(async () => {
  console.log("# calibrate @ " + new Date().toISOString() + " · " + ADDRS.length + " known insider wallet(s)");
  for (const addr of ADDRS) {
    console.log("\n========== " + addr + " ==========");
    let pm = null; try { pm = await poly.profileAggregates(addr); } catch (_) {}
    if (pm) console.log("Polymarket profile: @" + (pm.username || "?") + " · all-time P/L " + (pm.pnlAllTime != null ? "$" + Math.round(pm.pnlAllTime).toLocaleString("en-US") : "—") + " · predictions " + (pm.traded || "—"));
    const rec = await recordFor(addr);
    console.log("record: " + rec.trades + " trades · " + rec.cataloged + " markets resolved · " + rec.bets.length + " resolved bets");
    const ls = rec.bets.filter((b) => num(b.entryPrice) <= 0.35);
    const lsWon = ls.filter((b) => b.won).length;
    console.log("in-scope mix: " + rec.bets.filter((b) => b.category && !["Sports", "Crypto", "Weather", "Other"].includes(b.category)).length + " in-scope · " + ls.length + " long-shots (" + lsWon + " won)");
    const inScope = rec.bets.filter((b) => b.category && !["Sports", "Crypto", "Weather", "Other"].includes(b.category));
    // ON-CHAIN PROVENANCE (the Van Dyke signature): wallet age + funder (fresh) and
    // post-resolution cash-out (conceal), via the rotated keyless RPCs. Proves the
    // keyless path resolves without a Polygonscan key.
    const firstBetTs = inScope.reduce((m, b) => (b.ts && b.ts < m ? b.ts : m), Infinity);
    const lastResolved = inScope.reduce((m, b) => Math.max(m, b.resolvedMs || 0), 0);
    let firstSeenTs = null, fundingTs = null, funderLabel = null, priorTx = null, cashoutHours = null;
    try { firstSeenTs = await poly.firstSeen(addr); } catch (_) {}
    try { const fund = await chain.walletFunding(addr, isFinite(firstBetTs) ? firstBetTs : null, null); if (fund) { fundingTs = fund.ts; funderLabel = fund.label || fund.funder; } } catch (_) {}
    try { priorTx = await chain.priorTxCount(addr, isFinite(firstBetTs) ? firstBetTs : null); } catch (_) {}
    try { if (lastResolved) { const co = await chain.cashoutAfter(addr, Math.round(lastResolved / 1000)); if (co) cashoutHours = co.latencyHours; } } catch (_) {}
    const ageDays = (firstSeenTs && fundingTs) ? Math.round((firstSeenTs - fundingTs) / 86400) : null;
    console.log("on-chain: funder=" + (funderLabel || "—") + " · wallet age at 1st bet=" + (ageDays != null ? ageDays + "d" : "—") + " · prior tx=" + (priorTx != null ? priorTx : "—") + " · cash-out after win=" + (cashoutHours != null ? cashoutHours + "h" : "—") + (chain.hasScanKey() ? " (etherscan)" : " (keyless rpc)"));
    const conceal = (cashoutHours != null) ? { decoyRatio: 0, cashoutLatencyHours: cashoutHours } : null;
    const agg = { address: addr, bets: inScope, firstSeenTs: firstSeenTs, fundingTs: fundingTs, priorTx: priorTx, conceal: conceal };
    const { dets, f } = build.scoreAggregate(agg);
    console.log("TIER: " + (f.tier || "unflagged").toUpperCase() + "  fired=[" + (f.fired || []).join(",") + "]  agreeing=" + f.agreeing);
    const d = dets;
    if (d.won) console.log("  won:        " + (d.won.hasData ? ("n=" + d.won.n + " k=" + d.won.k + " p=" + (d.won.p != null ? d.won.p.toFixed(3) : "?") + " P=" + (d.won.P != null ? d.won.P.toExponential(2) : "?") + " (" + d.won.improbText + ")") : "no data (needs >=5 events)"));
    if (d.conviction) console.log("  conviction: " + (d.conviction.hasData ? ("$" + Math.round(d.conviction.stake).toLocaleString("en-US") + " @ " + Math.round(d.conviction.entryPrice * 100) + "% across " + (d.conviction.markets || 1) + " mkt(s) → fires=" + d.conviction.fires) : "no data"));
    if (d.longshot) console.log("  longshot:   " + (d.longshot.hasData ? ("mean " + Math.round(d.longshot.mean * 100) + "% fires=" + d.longshot.fires) : "no data"));
    if (d.held) console.log("  held:       " + (d.held.hasData ? ("rate " + (d.held.h != null ? Math.round(d.held.h * 100) : "?") + "% fires=" + d.held.fires) : "no data"));
    if (d.fresh) console.log("  fresh:      " + (d.fresh.hasData ? ("age " + (d.fresh.ageDays != null ? d.fresh.ageDays + "d" : "?") + " priorTx " + (d.fresh.priorTx != null ? d.fresh.priorTx : "?") + " fires=" + d.fresh.fires) : "no data (no funding trace)"));
    if (d.conceal) console.log("  conceal:    " + (d.conceal.hasData ? ("fires=" + d.conceal.fires) : "no data"));
    const subj = build.buildSubject(agg, 0, {});
    console.log("  PUBLISHED: " + (subj ? ("YES → " + subj.tier + " · " + subj.improbText) : "NO (not published)"));
  }
  console.log("\n# done");
})();
