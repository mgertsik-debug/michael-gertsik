/* ============================================================================
 *  /api/forensics/harvard-shadow — read API for the Harvard-model PREVIEW.
 *  ---------------------------------------------------------------------------
 *  Serves data/forensics/harvard-shadow.json — what the pure-Harvard composite
 *  (Ofir & Ofir 2026) WOULD flag on the live cron data, computed in shadow mode
 *  alongside (and without changing) the published binomial store. The preview
 *  page renders this so the Harvard "Suspicion Score" UI can be seen + reviewed
 *  BEFORE the live cutover — including while the scores are still being
 *  calibrated down to the paper's scale.
 *
 *  No secrets, no live fetch — a cheap static read of the committed diagnostic.
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const SHADOW = path.resolve(__dirname, "../../data/forensics/harvard-shadow.json");

function readShadow() {
  try { return require("../../data/forensics/harvard-shadow.json"); } catch (_) {}
  try { return JSON.parse(fs.readFileSync(SHADOW, "utf8")); } catch (_) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const s = readShadow();
  if (!s) { res.status(200).json({ total: 0, byTier: {}, onlyHarvard: 0, alsoBinomial: 0, top: [], calibrating: true }); return; }

  // Harvard's published reference distribution, carried so the preview can show how far our
  // live shadow scores are from the paper (median 105.3, range 40–3987, >500 = top 0.3%).
  const harvardRef = { median: 105.3, mean: 120.3, p90: 184.2, p95: 228.4, p99: 368.5, highTier: 500, min: 40, max: 3987.4 };
  const top = (s.top || []).slice().sort((a, b) => (b.S || 0) - (a.S || 0));
  const Ss = top.map((t) => t.S).filter((x) => isFinite(x)).sort((a, b) => a - b);
  const median = Ss.length ? Ss[Math.floor(Ss.length / 2)] : 0;

  res.status(200).json({
    total: s.total || top.length,
    byTier: s.byTier || {},
    onlyHarvard: s.onlyHarvard || 0,
    alsoBinomial: s.alsoBinomial || 0,
    // live funnel (same shape the real site's header shows) — Harvard's flagged/extreme counts
    observed: s.observed || 0,
    reviewed: s.reviewed || 0,
    screened: s.screened || 0,
    scored: s.scored || 0,
    extreme: (s.byTier && s.byTier.extreme) || 0,
    generatedAt: s.generatedAt || null,
    snapshot: s.snapshot || null,
    shadowMedianS: Math.round(median * 10) / 10,     // our current live shadow median (target: ~105)
    harvardRef,                                      // the paper's distribution, for the calibration gauge
    calibrating: !(median >= 80 && median <= 160),   // true until our median lands in Harvard's range
    top,
  });
};
