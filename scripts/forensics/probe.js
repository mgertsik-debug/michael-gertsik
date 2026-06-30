/* ============================================================================
 *  FORENSICS PROBE — a diagnostic "Polymarket terminal" that runs in CI.
 *
 *  The build/dev environment can't reach Polymarket (egress policy), but a
 *  GitHub Actions runner can. This probe pulls RAW Polymarket data for a wallet
 *  (and optionally one market) and prints it to the Action log, so a misattributed
 *  position (e.g. @greenfia's phantom $66K "John Ternus CEO" bet vs its real $191
 *  all-time P&L) can be root-caused with live data we otherwise can't see.
 *
 *  Trigger: Actions → forensics-probe → Run workflow, with:
 *     wallet = 0x...            (required)
 *     slug   = next-ceo-of-apple   (optional — the suspect market)
 *     cond   = 0x... (condition id) (optional — alternative to slug)
 *
 *  It answers three questions:
 *    1. What does Polymarket's AUTHORITATIVE profile say (P&L / volume / count)?
 *    2. Does the wallet's OWN /trades feed even contain the suspect market?
 *    3. In the suspect market, is the wallet attributed via proxyWallet (the real
 *       position-taker) or via maker/taker (the liquidity COUNTERPARTY — the bug)?
 * ========================================================================== */
"use strict";
const poly = require("../../api/forensics/poly.js");

const lc = (x) => String(x == null ? "" : x).toLowerCase();
const num = (x) => { const n = +x; return isFinite(n) ? n : 0; };

async function resolveCond(slug, cond) {
  if (cond) return cond;
  if (!slug) return null;
  const g = await poly.getJSON(poly.GAMMA + "/markets?slug=" + encodeURIComponent(slug), { timeout: 9000 }).catch(() => null);
  const arr = Array.isArray(g) ? g : (g && (g.data || g.markets)) || [];
  const m = arr[0];
  if (!m) { console.log("  (slug did not resolve to a market)"); return null; }
  console.log("  slug → question:", JSON.stringify(m.question), "| cond:", m.conditionId || m.condition_id, "| closed:", m.closed, "| events[0].slug:", m.events && m.events[0] && m.events[0].slug);
  return m.conditionId || m.condition_id || null;
}

(async () => {
  const wallet = lc(process.env.WALLET || process.argv[2]);
  const slug = process.env.SLUG || process.argv[3] || null;
  const cond0 = process.env.COND || process.argv[4] || null;
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) { console.log("PROBE ERROR: need a 0x… WALLET. got:", JSON.stringify(wallet)); process.exit(1); }

  console.log("================ FORENSICS PROBE ================");
  console.log("wallet:", wallet, "| slug:", slug, "| cond:", cond0);

  // 1) AUTHORITATIVE profile
  console.log("\n--- 1. AUTHORITATIVE PROFILE (leaderboard / data API) ---");
  const prof = await poly.profileAggregates(wallet).catch((e) => ({ err: String(e) }));
  console.log(JSON.stringify(prof));

  // 2) the wallet's OWN trades
  console.log("\n--- 2. THE WALLET'S OWN /trades?user= FEED ---");
  const ut = await poly.userTrades(wallet).catch(() => []);
  console.log("own-trade rows:", ut.length);
  const byCond = {};
  for (const t of ut) {
    const c = t.conditionId || t.market || t.condition_id; if (!c) continue;
    const e = byCond[c] || (byCond[c] = { cond: c, buyCost: 0, sells: 0, n: 0 });
    const sz = num(t.size), pr = num(t.price);
    if (lc(t.side) === "sell") e.sells += sz; else e.buyCost += sz * pr;
    e.n++;
  }
  const top = Object.values(byCond).sort((a, b) => b.buyCost - a.buyCost).slice(0, 12);
  console.log("top markets in the wallet's OWN trades (by buy cost):");
  top.forEach((e) => console.log("   cond " + String(e.cond).slice(0, 18) + "  buyCost $" + Math.round(e.buyCost) + "  rows " + e.n));

  // 3) deep-dive the suspect market's attribution
  console.log("\n--- 3. SUSPECT-MARKET ATTRIBUTION ---");
  const cond = await resolveCond(slug, cond0);
  if (!cond) { console.log("(no target market given/resolved — skipping attribution deep-dive)"); console.log("================ END PROBE ================"); return; }

  const ownHasIt = !!byCond[cond];
  console.log("does the wallet's OWN feed contain this market?", ownHasIt ? ("YES — buyCost $" + Math.round(byCond[cond].buyCost)) : "NO (⇒ the position came from the market sweep, not the wallet's own trades → misattribution)");

  const trades = await poly.tradesForMarket(cond).catch(() => []);
  console.log("market trade rows fetched:", trades.length, "(cap 4000)");
  const touch = trades.filter((t) => [t.proxyWallet, t.user, t.maker, t.taker, t.owner].some((f) => lc(f) === wallet));
  console.log("rows that touch the wallet on ANY field:", touch.length);

  let asProxy = 0, asMaker = 0, asTaker = 0, proxyBuyCost = 0, makerNotional = 0;
  for (const t of touch) {
    const pw = lc(t.proxyWallet || t.user), mk = lc(t.maker), tk = lc(t.taker);
    const sz = num(t.size), pr = num(t.price);
    if (pw === wallet) { asProxy++; if (lc(t.side) !== "sell") proxyBuyCost += sz * pr; }
    if (mk === wallet) { asMaker++; makerNotional += sz * pr; }
    if (tk === wallet) { asTaker++; }
  }
  console.log("ATTRIBUTION BREAKDOWN:");
  console.log("   as proxyWallet/user (the real bettor): " + asProxy + " rows, buy cost $" + Math.round(proxyBuyCost));
  console.log("   as maker (liquidity counterparty):     " + asMaker + " rows, notional $" + Math.round(makerNotional));
  console.log("   as taker:                              " + asTaker + " rows");
  console.log("VERDICT: aggregateMarket keys on (proxyWallet||user||maker||taker). If proxyBuyCost is small/zero");
  console.log("         but maker notional is large, the $ position was wrongly credited from the MAKER side.");
  console.log("sample raw rows touching the wallet:");
  console.log(JSON.stringify(touch.slice(0, 6).map((t) => ({ proxyWallet: t.proxyWallet, user: t.user, maker: t.maker, taker: t.taker, side: t.side, size: t.size, price: t.price, outcome: t.outcome })), null, 1));

  console.log("================ END PROBE ================");
})().catch((e) => { console.log("PROBE FATAL:", e && e.stack || e); process.exit(1); });
