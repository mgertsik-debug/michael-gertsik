"use strict";
// Real-data probe runner — runs INSIDE GitHub Actions (or any unsandboxed host)
// where Polymarket's public API is reachable, and prints the verbatim API shapes
// plus the scored output for one or more wallets. The build sandbox cannot reach
// data-api.polymarket.com (403), so this is how the live mapping gets verified:
// dispatch the workflow with an address, then read the run log back.
//
//   node scripts/forensics/probe-wallet.js 0xabc... 0xdef...
//   ADDR=0xabc... node scripts/forensics/probe-wallet.js
const diag = require("../../api/forensics/diagnose.js");
const poly = require("../../api/forensics/poly.js");

function jlog(label, obj) {
  console.log("\n===== " + label + " =====");
  console.log(JSON.stringify(obj, null, 2));
}

async function probe(addr) {
  addr = String(addr).trim().toLowerCase();
  console.log("\n\n##################################################");
  console.log("# WALLET " + addr);
  console.log("##################################################");

  // 1) verbatim Polymarket responses (the source of truth for field names)
  try { jlog("RAW PROBE (verbatim Polymarket API)", await diag.rawProbe(addr)); }
  catch (e) { console.log("rawProbe failed:", e && e.message); }

  // 2) what positionToBet actually does to the real /positions rows
  try {
    const positions = await poly.userPositions(addr);
    console.log("\n----- /positions rows fetched: " + positions.length + " -----");
    const bets = positions.map(poly.positionToBet);
    const kept = bets.filter(Boolean);
    console.log("positionToBet kept " + kept.length + " of " + positions.length + " (rest: open / out-of-scope / no entry odds)");
    jlog("first 3 RAW positions", positions.slice(0, 3));
    jlog("first 5 mapped bets (settled + in-scope only)", kept.slice(0, 5));
  } catch (e) { console.log("positions mapping failed:", e && e.message); }

  // 3) the full scored output exactly as the lookup endpoint returns it
  try {
    const scored = await diag.scoreWallet(addr);
    // trim the big arrays so the log stays readable but keeps the meaningful head
    const trimmed = Object.assign({}, scored, {
      ledger: (scored.ledger || []).slice(0, 8),
      sampleBets: (scored.sampleBets || []).slice(0, 8),
    });
    jlog("scoreWallet() OUTPUT (what Score-Any-Wallet shows)", trimmed);
    console.log("\nSUMMARY: " + (scored.verdict || "(no verdict)"));
  } catch (e) { console.log("scoreWallet failed:", e && e.message, e && e.stack); }
}

(async () => {
  const args = process.argv.slice(2).filter(Boolean);
  const fromEnv = (process.env.ADDR || "").split(/[\s,]+/).filter(Boolean);
  const list = (args.length ? args : fromEnv);
  if (!list.length) { console.log("no address given; pass 0x... as arg or ADDR env"); process.exit(0); }
  for (const a of list) { await probe(a); }
  console.log("\n\n# done — " + list.length + " wallet(s) probed");
})();
