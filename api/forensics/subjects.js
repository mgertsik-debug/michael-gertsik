/* ============================================================================
 *  /api/forensics/subjects — the read API the Wallet Forensics tab polls.
 *  ---------------------------------------------------------------------------
 *    GET /api/forensics/subjects?type=&category=&tier=&sort=&window=
 *
 *  Serves the ranked, flagged Polymarket subjects (wallets + clusters) the
 *  scheduled job persisted to data/forensics/store.json — the exact shapes the
 *  artifact's buildSubjects() produces. When the store is empty or missing we
 *  return { subjects: [] }; the front end then stays in honest SAMPLE mode
 *  rather than presenting seed data as real. No secrets, no live fetch — this
 *  is a cheap static read of the committed forensic ledger.
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const STORE = path.resolve(__dirname, "../../data/forensics/store.json");

// Read the committed store. Prefer require() — bundlers (Vercel) reliably include
// a statically-required JSON in the function bundle, whereas a runtime fs read of
// a repo file may be missing from the deployment. fs is the local-dev fallback.
function readStore() {
  try { return require("../../data/forensics/store.json"); } catch (_) {}
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (_) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const store = readStore();
  if (!store || !Array.isArray(store.subjects)) {
    res.status(200).json({ subjects: [], reviewed: 0, screened: 0, meta: {} });
    return;
  }

  const q = req.query || {};
  let subjects = store.subjects;

  if (q.type === "wallets") subjects = subjects.filter((s) => s.type === "wallet");
  else if (q.type === "clusters") subjects = subjects.filter((s) => s.type === "cluster");
  if (q.tier && q.tier !== "all") subjects = subjects.filter((s) => s.tier === q.tier);
  if (q.category && q.category !== "all") subjects = subjects.filter((s) => (s.category || "").toLowerCase() === String(q.category).toLowerCase());

  const sort = q.sort || "improbability";
  const by = {
    improbability: (a, b) => b.improbDenom - a.improbDenom,
    profit: (a, b) => (b.profitNum || 0) - (a.profitNum || 0),
    winrate: (a, b) => (b.winRate || 0) - (a.winRate || 0),
    volume: (a, b) => (b.volumeNum || 0) - (a.volumeNum || 0),
    recent: (a, b) => (a.activityDays || 0) - (b.activityDays || 0),
  }[sort] || ((a, b) => b.improbDenom - a.improbDenom);
  subjects = subjects.slice().sort(by);

  res.status(200).json({
    subjects,
    reviewed: store.reviewed || 0,
    screened: store.screened || 0,
    meta: store.meta || {},
    surpriseMarkets: store.surpriseMarkets || [],   // the haystack: long-shot upsets where money rode in early
    ringGroups: store.ringGroups || [],             // funding rings that touch a flagged wallet (auto ring-finder)
    rings: store.rings || 0,
    coverageByCategory: store.coverageByCategory || {},  // resolved markets cataloged per category (drives the filter)
    generatedAt: store.generatedAt || null,
  });
};
