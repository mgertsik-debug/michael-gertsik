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
const build = require("./build.js");                          // for the composite suspicion fallback
const { readLive } = require("./livestore.js");               // fetch the LATEST committed store at request time

const STORE = path.resolve(__dirname, "../../data/forensics/store.json");

// Read the store LIVE from GitHub raw (the scan commits it every ~10 min), so the site reflects each
// tick WITHOUT waiting for a Vercel rebuild — the redeploy path froze the whole site once data commits
// blew past the daily deploy cap. On any failure we fall back to the build-time copy: require() first
// (bundlers reliably include a statically-required JSON), then a runtime fs read for local dev.
async function readStore() {
  return await readLive("data/forensics/store.json", () => {
    try { return require("../../data/forensics/store.json"); } catch (_) {}
    try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (_) { return null; }
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  // Keep the edge cache SHORT so a browser refresh reflects the newest deployed scan quickly. The
  // store only changes when a scan redeploys, so a long TTL added pure staleness (users refreshed and
  // still saw the old "updated …" stamp) with no upside. 20s edge + brief stale-while-revalidate.
  res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const store = await readStore();
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

  // ensure every subject carries the composite suspicion score — compute a fallback for any store
  // generated before the field existed, so the new default ranking works immediately on deploy.
  subjects = subjects.map((s) => (s.suspicion != null ? s : Object.assign({}, s, { suspicion: build.suspicionScore(s) })));

  // DEFAULT = most recently DETECTED (a live feed: newest catch on top). Ordering by time means the
  // list never implies a suspiciousness ranking, so a bigger "1 in X" can't read as ranked below a
  // smaller one. firstFlaggedAt is a stable per-wallet first-detection timestamp; fall back to
  // activity recency, then improbability, so wallets without it still order sensibly.
  const sort = q.sort || "detected";
  const detectedBy = (a, b) => (b.firstFlaggedAt || 0) - (a.firstFlaggedAt || 0) || (a.activityDays || 1e9) - (b.activityDays || 1e9) || (b.improbDenom - a.improbDenom);
  const by = {
    detected: detectedBy,
    suspicion: (a, b) => (b.suspicion - a.suspicion) || (b.improbDenom - a.improbDenom),
    improbability: (a, b) => b.improbDenom - a.improbDenom,
    profit: (a, b) => (b.profitNum || 0) - (a.profitNum || 0),
    winrate: (a, b) => (b.winRate || 0) - (a.winRate || 0),
    volume: (a, b) => (b.volumeNum || 0) - (a.volumeNum || 0),
    recent: (a, b) => (a.activityDays || 0) - (b.activityDays || 0),
  }[sort] || detectedBy;
  subjects = subjects.slice().sort(by);

  res.status(200).json({
    subjects,
    reviewed: store.reviewed || 0,
    screened: store.screened || 0,
    scored: store.scored || (store.meta && store.meta.scored) || 0,   // wallets scored on improbability (percentile denominator)
    meta: store.meta || {},
    surpriseMarkets: store.surpriseMarkets || [],   // the haystack: long-shot upsets where money rode in early
    totalFlaggedProfit: store.totalFlaggedProfit || 0,         // aggregate estimated informed-trading P&L
    totalFlaggedProfitText: store.totalFlaggedProfitText || "$0",
    flaggedCount: store.flaggedCount != null ? store.flaggedCount : (store.subjects || []).length,
    ringGroups: store.ringGroups || [],             // funding rings that touch a flagged wallet (auto ring-finder)
    rings: store.rings || 0,
    coverageByCategory: store.coverageByCategory || {},  // resolved markets cataloged per category (drives the filter)
    validation: store.validation || null,            // permutation null test + per-detector win-rate lift (items 4+5)
    watchlist: Array.isArray(store.watchlist) ? store.watchlist : [],   // LIVE WATCHLIST: pre-resolution trade-time flags
    watchlistMeta: store.watchlistMeta || { total: (store.watchlist || []).length, watching: 0, promoted: 0 },
    generatedAt: store.generatedAt || null,
  });
};
