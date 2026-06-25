/* ============================================================================
 *  scan.js — rolling-coverage scanner state machine (§0A.2)
 *  ---------------------------------------------------------------------------
 *  The deployment profile is a static site + a ~45s serverless function +
 *  a 15-minute GitHub-Actions cron, with NO always-on backend. So "full live
 *  coverage" is impossible and we never claim it. Instead we keep a DURABLE
 *  QUEUE with a watermark, committed to the repo, and advance it every tick:
 *
 *    • ENUMERATE-LIGHT  — each tick the cron pulls /api/surveillance/feed for
 *      BOTH engines (insider + manipulation). The endpoint enumerates the full
 *      open universe and deep-enriches a bounded, rotating batch server-side.
 *    • DURABLE QUEUE    — every market the feed surfaces is upserted into
 *      data/surveillance/store.json with firstSeen / lastScanned / lastIndex /
 *      lastTier / deepEvaluated. The queue is the memory the serverless tier
 *      lacks; the watermark is the last successful tick.
 *    • ROLLING COVERAGE — we recompute oldest_unscanned_age across the queue
 *      and assert it stays under MAX_STALENESS_H; if it slips we log it loudly
 *      rather than hide it. Two HONEST counts are written: "watching" (the full
 *      tracked universe) and "evaluatedWithin" (deep-scored inside the window).
 *    • LIFECYCLE        — markets appear (new id), update (tier/score change),
 *      and retire (gone past graceDays) with an APPEND-ONLY audit trail.
 *
 *  Pure file-merge: the cron does the networking (it holds no secret — the feed
 *  endpoint holds the Kalshi key) and hands this script the two feed JSONs, so
 *  this stays deterministic and unit-testable.
 *
 *    node scripts/surveillance/scan.js feed-insider.json feed-manipulation.json
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

let DEFAULTS = {};
try { DEFAULTS = require("../../api/surveillance/detectors.js").DEFAULTS || {}; } catch (_) {}
const ENRICH_BATCH = DEFAULTS.ENRICH_BATCH || 250;
const MAX_STALENESS_H = DEFAULTS.MAX_STALENESS_H || 6;
const CRON_INTERVAL_MIN = DEFAULTS.CRON_INTERVAL_MIN || 15;
const GRACE_DAYS = DEFAULTS.graceDays || 14;
const PUBLISH_THRESHOLD = DEFAULTS.PUBLISH_THRESHOLD || "High-signal";

const DIR = path.resolve(__dirname, "../../data/surveillance");
const STORE = path.join(DIR, "store.json");
const HIST = path.join(DIR, "history.json");
const QUEUE_CAP = 5000;     // tracked-universe ceiling (queue is the durable memory)
const AUDIT_CAP = 1000;     // append-only lifecycle log ceiling
const HIST_CAP = 250;

function read(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; } }
const H = (ms) => ms / 3600000;

const nowIso = new Date().toISOString();
const nowMs = Date.parse(nowIso);

// ---- load the two engine feeds the cron pulled this tick ------------------
const feeds = process.argv.slice(2).map((f) => read(path.resolve(f), null)).filter(Boolean);
if (!feeds.length) { console.error("scan: no feed files given"); process.exit(0); }

const store = read(STORE, null) || {
  schema: 1, updatedAt: null, watermark: null, config: {}, counts: {}, queue: {}, audit: [],
};
store.queue = store.queue || {};
store.audit = store.audit || [];

const audit = (type, m, detail) => {
  store.audit.unshift({ ts: nowIso, type, id: m.id, platform: m.platform, engine: m.engine || m._engine, question: (m.question || "").slice(0, 140), detail: detail || "" });
};

// ---- upsert every market the feed surfaced this tick ----------------------
const seenThisTick = new Set();
let appeared = 0, updated = 0, deepCount = 0;
for (const feed of feeds) {
  const engine = feed.engine || feed.mode || "insider";
  for (const m of (feed.markets || [])) {
    if (!m || !m.id) continue;
    const key = engine + ":" + m.id;            // a market is tracked per-engine
    seenThisTick.add(key);
    const deep = !!(m.deep || (m.coverageRan != null && m.coverageTotal != null && m.coverageRan === m.coverageTotal));
    if (deep) deepCount++;
    const prev = store.queue[key];
    const entry = {
      key, id: m.id, platform: m.platform, category: m.category, question: m.question, url: m.url, engine,
      firstSeen: prev ? prev.firstSeen : nowIso,
      lastScanned: nowIso, lastScannedMs: nowMs,
      lastIndex: m.index != null ? m.index : (m.score != null ? m.score : null),
      lastTier: m.tier || null,
      deepEvaluated: deep, status: "active", retiredAt: null,
    };
    if (!prev) { audit("appear", { ...entry, _engine: engine }, m.tier || "tracked"); appeared++; }
    else if (prev.lastTier !== entry.lastTier) { audit("update", { ...entry, _engine: engine }, (prev.lastTier || "—") + " → " + (entry.lastTier || "—")); updated++; }
    store.queue[key] = entry;
  }
}

// ---- lifecycle: retire markets gone past the grace window -----------------
let retired = 0;
for (const key of Object.keys(store.queue)) {
  const e = store.queue[key];
  if (seenThisTick.has(key)) continue;
  if (e.status === "retired") continue;
  const ageH = H(nowMs - Date.parse(e.lastScanned || nowIso));
  if (ageH >= GRACE_DAYS * 24) {
    e.status = "retired"; e.retiredAt = nowIso;
    audit("retire", { ...e, _engine: e.engine }, "delisted/resolved · last seen " + Math.round(ageH / 24) + "d ago");
    retired++;
  }
}

// ---- rolling-coverage invariant: oldest_unscanned_age <= MAX_STALENESS ----
const active = Object.values(store.queue).filter((e) => e.status === "active");
let oldestUnscannedAgeH = 0, oldestId = null;
for (const e of active) {
  const ageH = H(nowMs - Date.parse(e.lastScanned || nowIso));
  if (ageH > oldestUnscannedAgeH) { oldestUnscannedAgeH = ageH; oldestId = e.id; }
}
const WINDOW_H = MAX_STALENESS_H;
const evaluatedWithin = active.filter((e) => e.deepEvaluated && H(nowMs - Date.parse(e.lastScanned)) <= WINDOW_H).length;
const stalenessOk = oldestUnscannedAgeH <= MAX_STALENESS_H;

const byTier = (t) => active.filter((e) => e.lastTier === t).length;

// ---- write the two HONEST counts + invariant + config ---------------------
store.config = { ENRICH_BATCH, MAX_STALENESS_H, CRON_INTERVAL_MIN, GRACE_DAYS, PUBLISH_THRESHOLD };
store.counts = {
  watching: active.length,                       // full tracked universe (honest "watching N")
  evaluatedWithin, evaluatedWindowH: WINDOW_H,    // deep-scored inside the staleness window
  highSignal: byTier("High-signal"), elevated: byTier("Elevated"), watch: byTier("Watch"),
  retired: Object.values(store.queue).filter((e) => e.status === "retired").length,
  deepThisTick: deepCount, appeared, updated, retired,
  oldestUnscannedAgeH: +oldestUnscannedAgeH.toFixed(2), oldestUnscannedId: oldestId, stalenessOk,
};
store.updatedAt = nowIso;
store.watermark = nowIso;
store.audit = store.audit.slice(0, AUDIT_CAP);

// cap the queue (drop the stalest retired entries first, then stalest active)
let entries = Object.values(store.queue);
if (entries.length > QUEUE_CAP) {
  entries.sort((a, b) => (a.status === b.status ? Date.parse(a.lastScanned) - Date.parse(b.lastScanned) : (a.status === "retired" ? -1 : 1)));
  const keep = entries.slice(entries.length - QUEUE_CAP);
  store.queue = {}; keep.forEach((e) => { store.queue[e.key] = e; });
}

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + "\n");

// ---- back-compat: append flagged alerts to the rolling history ------------
const hist = read(HIST, { updatedAt: null, sources: null, alerts: [] });
const seenAlert = new Set((hist.alerts || []).map((a) => a.id + ":" + (a.engine || "")));
let addedAlerts = 0;
for (const feed of feeds) {
  for (const a of (feed.alerts || [])) {
    if (!a || !a.id) continue;
    const k = a.id + ":" + (feed.engine || feed.mode || "");
    if (seenAlert.has(k)) continue;
    seenAlert.add(k);
    hist.alerts.unshift({ ...a, engine: feed.engine || feed.mode || "insider", firstSeen: nowIso });
    addedAlerts++;
  }
  if (feed.sources) hist.sources = feed.sources;
}
hist.alerts = (hist.alerts || []).slice(0, HIST_CAP);
hist.updatedAt = nowIso;
fs.writeFileSync(HIST, JSON.stringify(hist, null, 2) + "\n");

// ---- report (and flag a staleness breach loudly, never silently) ----------
console.log(
  "scan: watching " + store.counts.watching +
  " · evaluated≤" + WINDOW_H + "h " + evaluatedWithin +
  " · high " + store.counts.highSignal + " · elevated " + store.counts.elevated +
  " · +" + appeared + " appeared / " + updated + " updated / " + retired + " retired" +
  " · +" + addedAlerts + " alerts"
);
console.log("scan: oldest_unscanned_age = " + oldestUnscannedAgeH.toFixed(2) + "h (max " + MAX_STALENESS_H + "h) — " + (stalenessOk ? "OK" : "STALENESS BREACH"));
if (!stalenessOk) console.warn("scan: WARNING coverage staleness exceeded — increase ENRICH_BATCH or cron frequency.");
