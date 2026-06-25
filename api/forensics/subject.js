/* ============================================================================
 *  /api/forensics/subject — one subject's full dossier by id.
 *    GET /api/forensics/subject?id=w1   (or /api/forensics/subject/:id via rewrite)
 *  Reads the same committed store; returns the single subject payload the
 *  dossier view consumes, or 404 when the id is unknown.
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const STORE = path.resolve(__dirname, "../../data/forensics/store.json");
function readStore() {
  try { return require("../../data/forensics/store.json"); } catch (_) {}
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (_) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const q = req.query || {};
  let id = q.id;
  if (!id && req.url) { const m = String(req.url).match(/\/subject\/([^/?]+)/); if (m) id = decodeURIComponent(m[1]); }
  if (!id) { res.status(400).json({ error: "missing id" }); return; }

  const store = readStore();
  const subject = store && Array.isArray(store.subjects) ? store.subjects.find((s) => s.id === id) : null;
  if (!subject) { res.status(404).json({ error: "subject not found", id }); return; }
  res.status(200).json({ subject, meta: store.meta || {}, generatedAt: store.generatedAt || null });
};
