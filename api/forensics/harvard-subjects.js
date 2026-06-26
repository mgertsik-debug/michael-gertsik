/* ============================================================================
 *  /api/forensics/harvard-subjects — read API for the Harvard-model PREVIEW.
 *  ---------------------------------------------------------------------------
 *  Serves data/forensics/harvard-store.json: the SAME full subject dossiers the
 *  live Wallet-Forensics UI renders (ledger, graphs, tx, WHO, scorecard), but
 *  scored with the pure-Harvard composite (Ofir & Ofir 2026) — Suspicion Score
 *  + five-signal breakdown. The preview is the real UI (wallet-forensics.html
 *  ?model=harvard) pointed at this endpoint, so the format is identical and only
 *  the metrics change. Never touches the published binomial store.
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const STORE = path.resolve(__dirname, "../../data/forensics/harvard-store.json");

function readStore() {
  try { return require("../../data/forensics/harvard-store.json"); } catch (_) {}
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (_) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const store = readStore();
  if (!store || !Array.isArray(store.subjects)) {
    res.status(200).json({ subjects: [], reviewed: 0, screened: 0, meta: {}, model: "harvard", calibrating: true });
    return;
  }

  const q = req.query || {};
  let subjects = store.subjects;
  if (q.tier && q.tier !== "all") subjects = subjects.filter((s) => s.tier === q.tier);
  if (q.category && q.category !== "all") subjects = subjects.filter((s) => (s.category || "").toLowerCase() === String(q.category).toLowerCase());
  // default sort = Suspicion Score (improbDenom carries S for Harvard subjects)
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
    model: "harvard",
    subjects,
    reviewed: store.reviewed || 0,
    screened: store.screened || 0,
    scored: store.scored || (store.meta && store.meta.scored) || 0,
    meta: store.meta || {},
    totalFlaggedProfit: store.totalFlaggedProfit || 0,
    totalFlaggedProfitText: store.totalFlaggedProfitText || "$0",
    flaggedCount: store.flaggedCount != null ? store.flaggedCount : (store.subjects || []).length,
    observed: store.observed || (store.meta && store.meta.observed) || 0,
    generatedAt: store.generatedAt || null,
  });
};
