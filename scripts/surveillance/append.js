/* ============================================================================
 *  append.js — merge a surveillance feed pull into the rolling history
 *  ---------------------------------------------------------------------------
 *  Reads a feed JSON (the output of /api/surveillance/feed) and appends any
 *  alerts not already in data/surveillance/history.json, newest first, each
 *  stamped with firstSeen. Caps the file so it can't grow without bound. The
 *  background cron calls this; the model can later read the history so flags
 *  persist even when no one is actively polling.
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const HIST = path.resolve(__dirname, "../../data/surveillance/history.json");
const CAP = 250;

function read(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; } }

const feed = read(path.resolve(process.argv[2] || "feed.json"), { alerts: [] });
const hist = read(HIST, { updatedAt: null, sources: null, alerts: [] });
const now = new Date().toISOString();

const seen = new Set(hist.alerts.map((a) => a.id));
let added = 0;
for (const a of feed.alerts || []) {
  if (!a || !a.id || seen.has(a.id)) continue;
  seen.add(a.id);
  hist.alerts.unshift({ ...a, firstSeen: now });
  added++;
}
hist.alerts = hist.alerts.slice(0, CAP);
hist.updatedAt = now;
if (feed.sources) hist.sources = feed.sources;

fs.mkdirSync(path.dirname(HIST), { recursive: true });
fs.writeFileSync(HIST, JSON.stringify(hist, null, 2) + "\n");
console.log(`added ${added} new flag(s); history now ${hist.alerts.length}`);
