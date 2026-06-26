"use strict";
// REAL POLYMARKET API PROBE — runs in GitHub Actions (networked) so we can see the
// EXACT shape/values the Data API returns for a real wallet, and map our lookup to
// match Polymarket's own profile numbers instead of guessing. Dumps /value,
// /positions, /trades, /activity verbatim (first rows) plus computed aggregates we
// can compare against the wallet's Polymarket page.
const DATA = "https://data-api.polymarket.com";
const ADDR = (process.env.ADDR || "0x204f72f35326db932158cba6adff0b9a1da95e14").toLowerCase();
const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };

async function get(url) {
  try {
    const r = await fetch(url, { headers: { "accept": "application/json" } });
    const status = r.status;
    let body = null; try { body = await r.json(); } catch (_) { body = (await r.text().catch(() => "")).slice(0, 300); }
    return { status, body };
  } catch (e) { return { error: String(e && e.message || e) }; }
}
function arrify(b) { return Array.isArray(b) ? b : (b && (b.data || b.positions || b.trades || b.activity)) || []; }

(async () => {
  console.log("# polyprobe " + ADDR + " @ " + new Date().toISOString());

  const val = await get(DATA + "/value?user=" + ADDR);
  console.log("\n=== /value ===\nstatus " + val.status + "\n" + JSON.stringify(val.body).slice(0, 400));

  // Candidate endpoints for the wallet's ALL-TIME P/L + volume headline (what the
  // Polymarket profile shows) — /positions only has CURRENT holdings, so we need one
  // of these to mirror their numbers.
  for (const u of [
    "https://user-pnl-api.polymarket.com/user-pnl?user_address=" + ADDR + "&interval=all&fidelity=1d",
    "https://lb-api.polymarket.com/profit?window=all&limit=1&address=" + ADDR,
    "https://lb-api.polymarket.com/volume?window=all&limit=1&address=" + ADDR,
    DATA + "/traded?user=" + ADDR,
  ]) {
    const r = await get(u);
    let s = JSON.stringify(r.body);
    if (Array.isArray(r.body)) s = "[len " + r.body.length + "] " + JSON.stringify(r.body.slice(-2));
    console.log("\n=== " + u.split("?")[0].replace(/^https?:\/\//, "") + " ===\nstatus " + r.status + "\n" + String(s).slice(0, 360));
  }

  const posR = await get(DATA + "/positions?user=" + ADDR + "&limit=500&sortBy=CURRENT&sortDirection=DESC");
  const pos = arrify(posR.body);
  console.log("\n=== /positions ===\nstatus " + posR.status + " · count " + pos.length);
  if (pos[0]) console.log("keys: " + JSON.stringify(Object.keys(pos[0])));
  pos.slice(0, 4).forEach((p, i) => console.log("  [" + i + "] " + JSON.stringify(p)));
  // computed aggregates to compare against the Polymarket profile
  if (pos.length) {
    const pnl = pos.reduce((a, p) => a + num(p.cashPnl != null ? p.cashPnl : p.realizedPnl), 0);
    const curVal = pos.reduce((a, p) => a + num(p.currentValue != null ? p.currentValue : p.curValue), 0);
    const redeemable = pos.filter((p) => p.redeemable === true).length;
    const settledByPrice = pos.filter((p) => num(p.curPrice) <= 0.02 || num(p.curPrice) >= 0.98).length;
    console.log("AGG: Σ cashPnl=" + Math.round(pnl) + " · Σ currentValue=" + Math.round(curVal) +
      " · redeemable=" + redeemable + " · price-settled=" + settledByPrice + " · open(mid-price,!redeem)=" + (pos.length - redeemable - settledByPrice));
    // outcome/side distribution and a couple of fully-expanded rows
    const sides = {}; pos.forEach((p) => { const o = String(p.outcome); sides[o] = (sides[o] || 0) + 1; });
    console.log("outcome field values: " + JSON.stringify(sides));
  }

  const trR = await get(DATA + "/trades?user=" + ADDR + "&limit=8&takerOnly=false");
  const tr = arrify(trR.body);
  console.log("\n=== /trades ===\nstatus " + trR.status + " · count " + tr.length);
  if (tr[0]) console.log("keys: " + JSON.stringify(Object.keys(tr[0])));
  tr.slice(0, 3).forEach((t, i) => console.log("  [" + i + "] proxyWallet=" + t.proxyWallet + " cond=" + (t.conditionId || t.market) + " side=" + t.side + " outcome=" + t.outcome + " price=" + t.price + " size=" + t.size));
  const mine = tr.filter((t) => String(t.proxyWallet || "").toLowerCase() === ADDR).length;
  console.log("trades whose proxyWallet == target: " + mine + " / " + tr.length + (mine < tr.length ? "  <<< /trades?user= LEAKS GLOBAL ROWS" : "  (clean)"));

  const acR = await get(DATA + "/activity?user=" + ADDR + "&limit=5");
  const ac = arrify(acR.body);
  console.log("\n=== /activity ===\nstatus " + acR.status + " · count " + ac.length);
  if (ac[0]) console.log("keys: " + JSON.stringify(Object.keys(ac[0])));

  console.log("\n# done");
})();
