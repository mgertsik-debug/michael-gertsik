#!/usr/bin/env node
/* ============================================================================
 *  ingest.js — CourtListener -> Prediction Market Litigation Explorer
 *  ---------------------------------------------------------------------------
 *  Watches CourtListener for new Kalshi / Polymarket prediction-market dockets
 *  and produces REVIEW-PENDING draft matters that conform to
 *  models/pmle/DATA_CONTRACT.md. It never fabricates a legal fact and never
 *  writes to data.js without an explicit --approve (review-before-publish).
 *
 *  Vanilla Node (>=18), zero dependencies — so it can never break the static
 *  Vercel build (there is no package.json / build step to disturb).
 *
 *  USAGE
 *    node scripts/ingest/ingest.js --dry-run --backfill [--days 60]
 *        Fetch the window, show the INSERT/UPSERT/SKIP/HELD diff, write nothing.
 *    node scripts/ingest/ingest.js                 # incremental, writes pending/
 *    node scripts/ingest/ingest.js --review        # list pending drafts + gaps
 *    node scripts/ingest/ingest.js --approve <id>  # publish one draft to data.js
 *    node scripts/ingest/ingest.js --approve-all   # publish all reviewed drafts
 *
 *  DATA SOURCE
 *    - Live:  CourtListener REST v4, token from env COURTLISTENER_API_TOKEN.
 *    - Offline / CI test:  --fixture <path.json> (array of docket records, or a
 *      { results:[...] } object). Lets the dry-run run with no token.
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const { classify } = require("./lib/relevance");
const { toDraftMatter } = require("./lib/transform");
const { loadRepo, docketIdOf, DATA_PATH } = require("./lib/repo");
const { docketIdFromMatter, fetchDocketStatus, computeRefresh } = require("./lib/refresh");

const ROOT = path.resolve(__dirname, "../..");
const INGEST_DIR = path.join(ROOT, "data", "ingest");
const PENDING_DIR = path.join(INGEST_DIR, "pending");
const SEEN_PATH = path.join(INGEST_DIR, "seen.json");
const HELD_PATH = path.join(INGEST_DIR, "held.json");
const WATERMARK_PATH = path.join(INGEST_DIR, "watermark.json");

// Queries the pipeline runs. Each is a CourtListener docket (type=d) search.
const QUERIES = [
  { platform: "Kalshi", q: "Kalshi" },
  { platform: "Polymarket", q: "Polymarket" },
];

/* ----------------------------------------------------------------- args ---- */
function parseArgs(argv) {
  const a = {
    dryRun: false, backfill: false, days: 60, auto: false, review: false,
    approve: null, approveAll: false, allowStub: false, fixture: null, quiet: false,
    noRefresh: false, refreshOnly: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run") a.dryRun = true;
    else if (t === "--backfill") a.backfill = true;
    else if (t === "--auto") a.auto = true;
    else if (t === "--review") a.review = true;
    else if (t === "--approve-all") a.approveAll = true;
    else if (t === "--allow-stub") a.allowStub = true;
    else if (t === "--quiet") a.quiet = true;
    else if (t === "--no-refresh") a.noRefresh = true;      // skip the status-refresh pass
    else if (t === "--refresh-only") a.refreshOnly = true;  // ONLY re-poll existing matters
    else if (t === "--approve") a.approve = argv[++i];
    else if (t === "--days") a.days = parseInt(argv[++i], 10) || 60;
    else if (t === "--fixture") a.fixture = argv[++i];
  }
  return a;
}

/* --------------------------------------------------------------- helpers --- */
function todayISO() {
  // Pipeline runs stamp the run date. Allowed here (this is a CLI, not the
  // browser model); the model code itself never calls Date.now().
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}
const C = {
  ins: "\x1b[32m", upd: "\x1b[36m", skip: "\x1b[90m", held: "\x1b[33m",
  bold: "\x1b[1m", dim: "\x1b[2m", off: "\x1b[0m", red: "\x1b[31m",
};
function log(...x) { console.log(...x); }

/* ----------------------------------------------------- CourtListener I/O --- */
function clGet(urlPath) {
  const token = process.env.COURTLISTENER_API_TOKEN;
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "www.courtlistener.com",
      path: urlPath,
      method: "GET",
      headers: { "User-Agent": "pmle-ingest", Accept: "application/json" },
    };
    if (token) opts.headers.Authorization = "Token " + token;
    https.get(opts, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else reject(new Error("CourtListener HTTP " + res.statusCode + ": " + body.slice(0, 200)));
      });
    }).on("error", reject);
  });
}

const SEARCH_FIELDS = [
  "docket_id", "caseName", "docketNumber", "court_id", "dateFiled",
  "dateTerminated", "suitNature", "docket_absolute_url", "party",
];

/** Fetch all dockets for one query since `filedAfter`, paginating. */
async function fetchQuery(q, filedAfter) {
  const out = [];
  const params = new URLSearchParams({
    type: "d", q: q.q, order_by: "dateFiled desc", filed_after: filedAfter,
  });
  SEARCH_FIELDS.forEach((f) => params.append("fields", f));
  let urlPath = "/api/rest/v4/search/?" + params.toString();
  let guard = 0;
  while (urlPath && guard++ < 20) {
    const page = await clGet(urlPath);
    (page.results || []).forEach((r) => out.push(r));
    urlPath = page.next ? page.next.replace(/^https?:\/\/www\.courtlistener\.com/, "") : null;
  }
  return out;
}

/** Load docket records either from a fixture file or live from CourtListener. */
async function gatherDockets(args) {
  const filedAfter = args.backfill ? daysAgoISO(args.days) : (readWatermark().lastFiledAfter || daysAgoISO(args.days));
  if (args.fixture) {
    const raw = readJSON(path.resolve(args.fixture), null);
    if (!raw) throw new Error("Could not read fixture: " + args.fixture);
    const records = Array.isArray(raw) ? raw : (raw.results || []);
    // a fixture may tag records with `_query`/`_platform`; otherwise classify decides
    return { records, filedAfter, source: "fixture:" + args.fixture };
  }
  if (!process.env.COURTLISTENER_API_TOKEN) {
    throw new Error(
      "No COURTLISTENER_API_TOKEN in env and no --fixture given. " +
      "Set the token to fetch live, or pass --fixture <path> for an offline run."
    );
  }
  let records = [];
  for (const q of QUERIES) {
    const recs = await fetchQuery(q, filedAfter);
    recs.forEach((r) => (r._query = q.q));
    records = records.concat(recs);
  }
  return { records, filedAfter, source: "courtlistener:live" };
}

/* ----------------------------------------------------------- watermark ---- */
function readWatermark() { return readJSON(WATERMARK_PATH, {}); }

/* ----------------------------------------- known docket-id index (dedupe) -- */
/** Every docket_id already represented in data.js, from id tails AND from any
 *  courtlistener.com/docket/<id>/ URL in a matter's sources. */
function knownDocketIds(matters) {
  const ids = new Map(); // docketId -> matter id
  for (const m of matters) {
    const tail = docketIdOf(m.id);
    if (tail) ids.set(tail, m.id);
    for (const s of m.sources || []) {
      const mm = String(s).match(/courtlistener\.com\/docket\/(\d+)\//);
      if (mm) ids.set(Number(mm[1]), m.id);
    }
  }
  return ids;
}

/* --------------------------------------------------------------- diffing --- */
/** Build the proposed change set against the live data + ledger. */
function buildDiff(records, repo, seen) {
  const known = knownDocketIds(repo.matters);
  const seenIds = new Set((seen.dockets || []).map((d) => d.docketId));
  const ingestDate = todayISO();

  const inserts = [], upserts = [], skips = [], held = [];
  const byDocket = new Map(); // de-dupe identical docket_ids within one run

  for (const d of records) {
    const cls = classify(d);
    const docketId = d.docket_id != null ? d.docket_id : null;
    if (!cls.accept) {
      held.push({ caption: d.caseName, docketId, court_id: d.court_id, reason: cls.reason });
      continue;
    }
    if (docketId == null) {
      held.push({ caption: d.caseName, docketId: null, court_id: d.court_id, reason: "no docket_id on record" });
      continue;
    }
    if (byDocket.has(docketId)) continue; // collapse duplicate hits in one run
    byDocket.set(docketId, true);

    const { matter, review } = toDraftMatter(d, {
      platform: cls.platform, query: d._query || cls.platform, ingestDate,
    });

    if (known.has(docketId)) {
      // already in data.js — candidate upsert (auto fields only)
      const existingId = known.get(docketId);
      const existing = repo.matters.find((m) => m.id === existingId);
      const changes = upsertChanges(existing, d, ingestDate);
      if (changes.length) upserts.push({ matter, existingId, changes, review });
      else skips.push({ caption: matter.caption, docketId, reason: "already present, no auto-field change" });
    } else if (seenIds.has(docketId)) {
      skips.push({ caption: matter.caption, docketId, reason: "in ledger (pending/handled), unchanged" });
    } else {
      inserts.push({ matter, review });
    }
  }
  return { inserts, upserts, skips, held, ingestDate };
}

/** Which auto-derivable fields would change on an existing matter. */
function upsertChanges(existing, d, ingestDate) {
  if (!existing) return [];
  const ch = [];
  const newDecided = d.dateTerminated || null;
  if (newDecided && !existing.decidedDate) ch.push(["decidedDate", existing.decidedDate, newDecided]);
  // lastUpdate is informational; only count it as a change if something else did
  return ch;
}

/* --------------------------------------------------------- serialization -- */
/** House style: one JSON.stringify'd object per line, 4-space indent. */
function serializeMatter(m) { return "    " + JSON.stringify(m) + ","; }

/** Splice new matters in at the TOP of PMLE.matters, preserving everything. */
function publishToDataJs(newMatters) {
  let text = fs.readFileSync(DATA_PATH, "utf8");
  const anchor = "PMLE.matters = [";
  const idx = text.indexOf(anchor);
  if (idx === -1) throw new Error("Could not find `PMLE.matters = [` in data.js");
  const insertAt = text.indexOf("\n", idx) + 1;
  const block = newMatters.map(serializeMatter).join("\n") + "\n";
  text = text.slice(0, insertAt) + block + text.slice(insertAt);
  fs.writeFileSync(DATA_PATH, text);
}

/* -------------------------------------------------- status refresh (live) -- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Re-poll every tracked matter's docket and compute honest field updates.
 *  Sequential + adaptive to CourtListener's rate limit: a small base gap, and
 *  on HTTP 429 it backs off and retries so a free-tier token (5/min) still
 *  completes instead of aborting. Matters without a CL docket are skipped. */
async function runRefresh(repo, args) {
  const today = todayISO();
  const targets = repo.matters
    .map((m) => ({ m, docketId: docketIdFromMatter(m) }))
    .filter((x) => x.docketId != null);
  log(`\n${C.bold}Status refresh${C.off} ${C.dim}(re-polling ${targets.length} tracked docket(s) for updates)${C.off}`);

  const refreshes = [];
  // Pace to respect CourtListener's free-tier limit (5 req/min ≈ one per 12s).
  // Override via INGEST_REFRESH_GAP_MS if the repo's token has a higher tier.
  // The 429 backoff below is the backstop if we still get throttled.
  const baseGap = parseInt(process.env.INGEST_REFRESH_GAP_MS, 10) || 13000;
  for (const { m, docketId } of targets) {
    let status = null;
    for (let attempt = 0; attempt < 4 && !status; attempt++) {
      try {
        status = await fetchDocketStatus(clGet, docketId);
      } catch (e) {
        const msg = String(e && e.message || e);
        if (/HTTP 429/.test(msg) && attempt < 3) { await sleep(20000); continue; }  // throttled — back off + retry
        log(`${C.dim}  · skip ${m.id} (docket ${docketId}): ${msg.slice(0, 80)}${C.off}`);
        break;
      }
    }
    if (!status) { await sleep(baseGap); continue; }
    const r = computeRefresh(m, status, today);
    if (r.changes.length || r.flagOutcome) refreshes.push(r);
    await sleep(baseGap);
  }
  return refreshes;
}

/** Apply refresh field updates to data.js IN PLACE. Only ever writes the two
 *  auto-derivable date fields (lastUpdate, decidedDate); never touches a field
 *  that carries legal judgment (gate/outcome/posture/summary/…), honoring the
 *  DATA_CONTRACT sticky-human-edit rule. Rewrites only the changed matter lines,
 *  preserving the rest of the file byte-for-byte. Returns count applied. */
const REFRESH_FIELDS = ["lastUpdate", "decidedDate"];
function applyFieldUpdates(refreshes) {
  const byId = new Map(refreshes.map((r) => [r.id, r]));
  const lines = fs.readFileSync(DATA_PATH, "utf8").split("\n");
  let applied = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().replace(/,\s*$/, "");
    if (!t.startsWith("{")) continue;
    let obj;
    try { obj = JSON.parse(t); } catch (_) { continue; }
    if (!obj || !obj.id || !byId.has(obj.id)) continue;
    const r = byId.get(obj.id);
    let changed = false;
    for (const f of REFRESH_FIELDS) {
      if (r[f] !== undefined && obj[f] !== r[f]) { obj[f] = r[f]; changed = true; }
    }
    if (changed) { lines[i] = serializeMatter(obj); applied++; }
  }
  if (applied) fs.writeFileSync(DATA_PATH, lines.join("\n"));
  return applied;
}

/** Print the STATUS REFRESH section and list matters needing a human outcome. */
function reportRefresh(refreshes) {
  if (!refreshes.length) { log(`${C.dim}  no status changes — every tracked docket already current.${C.off}`); return; }
  log(`${C.upd}${C.bold}STATUS REFRESH (auto date fields on existing matters)${C.off}`);
  refreshes.forEach((r) => {
    log(`${C.upd}  ~ ${r.id}${C.off}`);
    r.changes.forEach(([f, was, now]) => log(`      ${f}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`));
  });
  const flagged = refreshes.filter((r) => r.flagOutcome);
  if (flagged.length) {
    log(`\n${C.held}${C.bold}NEEDS HUMAN OUTCOME (docket terminated; posture/outcome left untouched):${C.off}`);
    flagged.forEach((r) => log(`${C.held}  ⚑${C.off} ${r.id}`));
  }
  log("");
}

/* --------------------------------------------------------------- reports -- */
function printDiff(diff, source) {
  const { inserts, upserts, skips, held } = diff;
  log(`\n${C.bold}CourtListener ingest — proposed changes${C.off}  ${C.dim}(${source})${C.off}`);
  log(`${C.dim}────────────────────────────────────────────────────────────${C.off}`);
  log(`${C.ins}+ ${inserts.length} INSERT${C.off}   ${C.upd}~ ${upserts.length} UPSERT${C.off}   ${C.skip}· ${skips.length} SKIP${C.off}   ${C.held}⚑ ${held.length} HELD${C.off}\n`);

  if (inserts.length) {
    log(`${C.ins}${C.bold}NEW MATTERS (review-pending) — nothing written yet${C.off}`);
    inserts.forEach(({ matter, review }, i) => {
      log(`${C.ins}  + ${matter.caption}${C.off}`);
      log(`      id        ${matter.id}`);
      log(`      platform  ${matter.platform}   court ${matter.courtForum}   states [${matter.states.join(",")}]`);
      log(`      docket    ${matter.docketNumber || "—"}   filed ${matter.filedDate || "—"}   decided ${matter.decidedDate || "—"}`);
      log(`      parties   ${matter.parties.map((p) => p.name).join("; ") || "—"}`);
      log(`      source    ${matter.sources[0] || "—"}`);
      log(`      ${C.held}needs review:${C.off} ${review.needsReview.join(", ")}`);
      if (i < inserts.length - 1) log("");
    });
    log("");
  }
  if (upserts.length) {
    log(`${C.upd}${C.bold}UPSERTS (refresh auto fields on existing matters)${C.off}`);
    upserts.forEach(({ existingId, changes }) => {
      log(`${C.upd}  ~ ${existingId}${C.off}`);
      changes.forEach(([f, was, now]) => log(`      ${f}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`));
    });
    log("");
  }
  if (held.length) {
    log(`${C.held}${C.bold}HELD (failed relevance gate — logged, not published)${C.off}`);
    held.slice(0, 40).forEach((h) => log(`${C.held}  ⚑${C.off} ${h.caption || "—"} ${C.dim}[${h.court_id || "?"}] — ${h.reason}${C.off}`));
    if (held.length > 40) log(`${C.dim}      …and ${held.length - 40} more (see held.json on a real run)${C.off}`);
    log("");
  }
  if (skips.length && !diff._quiet) {
    log(`${C.skip}SKIP (already present / in ledger, unchanged): ${skips.length}${C.off}`);
  }
}

/* ----------------------------------------------------------------- review -- */
function listPending() {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json"));
  if (!files.length) { log("No pending drafts."); return; }
  log(`${C.bold}${files.length} pending draft(s):${C.off}\n`);
  for (const f of files) {
    const d = readJSON(path.join(PENDING_DIR, f), {});
    const m = d.matter || {};
    log(`${C.ins}${m.id}${C.off}  ${m.caption}`);
    log(`   ${C.held}needs review:${C.off} ${(d.review && d.review.needsReview || []).join(", ")}`);
    log(`   source: ${(m.sources || [])[0] || "—"}\n`);
  }
  log(`Approve with:  node scripts/ingest/ingest.js --approve <id>   (or --approve-all)`);
}

function writePending(diff) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  diff.inserts.forEach(({ matter, review }) => {
    writeJSON(path.join(PENDING_DIR, matter.id + ".json"), { matter, review });
  });
}

function approve(ids, args, repo) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  let pool = ids;
  if (args.approveAll) {
    pool = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  }
  if (!pool || !pool.length) { log("Nothing to approve."); return; }

  const toPublish = [];
  for (const id of pool) {
    const p = path.join(PENDING_DIR, id + ".json");
    const draft = readJSON(p, null);
    if (!draft) { log(`${C.red}skip:${C.off} no pending draft for ${id}`); continue; }
    const gaps = (draft.review && draft.review.needsReview) || [];
    const onlyStub = gaps.every((g) => ["summary", "parties.role", "statutes", "doctrinalQuestion"].includes(g));
    if (gaps.length && !args.allowStub && !onlyStub) {
      log(`${C.red}refuse:${C.off} ${id} still needs review of [${gaps.join(", ")}] — edit the draft or pass --allow-stub`);
      continue;
    }
    toPublish.push(draft.matter);
  }
  if (!toPublish.length) { log("No drafts cleared for publish."); return; }

  publishToDataJs(toPublish);

  // re-validate the now-updated repo
  const after = loadRepo();
  const problems = after.PMLE.validate(after.matters, after.constants);
  if (problems.length) {
    log(`${C.red}VALIDATION FAILED after publish — ${problems.length} issue(s):${C.off}`);
    problems.forEach((p) => log("  • " + p));
    log(`${C.red}data.js was modified; review the diff and fix before committing.${C.off}`);
  } else {
    log(`${C.ins}Published ${toPublish.length} matter(s) to data.js. Validator clean.${C.off}`);
  }

  // move approved drafts out of pending, record in ledger
  const seen = readJSON(SEEN_PATH, { dockets: [] });
  for (const m of toPublish) {
    const docketId = docketIdOf(m.id);
    seen.dockets.push({ docketId, id: m.id, publishedAt: todayISO() });
    try { fs.unlinkSync(path.join(PENDING_DIR, m.id + ".json")); } catch (_) {}
  }
  writeJSON(SEEN_PATH, seen);
}

/* -------------------------------------------------------------------- main -- */
/** Re-load the repo and run the model's own validator; log the result. */
function revalidate(label) {
  const after = loadRepo();
  const problems = after.PMLE.validate ? after.PMLE.validate(after.matters, after.constants) : [];
  if (problems.length) {
    log(`${C.red}VALIDATION FAILED after ${label} — ${problems.length} issue(s):${C.off}`);
    problems.forEach((p) => log("  • " + p));
  } else {
    log(`${C.ins}${label}: validator clean.${C.off}`);
  }
  return problems.length === 0;
}

/** Whether the status-refresh pass should run this invocation. Live only
 *  (needs the token), skipped with --no-refresh, forced by --refresh-only or a
 *  dry-run, otherwise throttled to once per day via the watermark. */
function shouldRefresh(args) {
  if (args.noRefresh) return false;
  if (args.fixture) return false;                        // offline test path
  if (!process.env.COURTLISTENER_API_TOKEN) return false;
  if (args.refreshOnly || args.dryRun) return true;
  return readWatermark().lastRefresh !== todayISO();     // once/day
}

async function main() {
  const args = parseArgs(process.argv);
  const repo = loadRepo();

  if (args.review) return listPending();
  if (args.approve || args.approveAll) return approve(args.approve ? [args.approve] : [], args, repo);

  // --refresh-only: re-poll existing matters and stop (no insert scan).
  if (args.refreshOnly) {
    const refreshes = await runRefresh(repo, args);
    reportRefresh(refreshes);
    if (args.dryRun) { log(`${C.dim}--dry-run: nothing written.${C.off}`); return; }
    const n = applyFieldUpdates(refreshes);
    if (n) revalidate(`status refresh (${n} matter(s))`);
    writeJSON(WATERMARK_PATH, { ...readWatermark(), lastRefresh: todayISO() });
    return;
  }

  const { records, filedAfter, source } = await gatherDockets(args);
  const seen = readJSON(SEEN_PATH, { dockets: [] });
  const diff = buildDiff(records, repo, seen);
  diff._quiet = args.quiet;

  printDiff(diff, `${source}, filed_after ${filedAfter}, ${records.length} raw hits`);

  // Status-refresh pass: keep EVERY existing matter live, not just new filings.
  const refreshRan = shouldRefresh(args);
  let refreshes = [];
  if (refreshRan) {
    refreshes = await runRefresh(repo, args);
    reportRefresh(refreshes);
  }

  if (args.dryRun) {
    log(`${C.dim}--dry-run: nothing written. Re-run without --dry-run to stage drafts + apply refreshes.${C.off}`);
    return;
  }

  // stage insert drafts (review-before-publish). Never touches data.js here.
  writePending(diff);
  writeJSON(HELD_PATH, { generatedAt: todayISO(), held: diff.held });
  log(`\nStaged ${diff.inserts.length} draft(s) into data/ingest/pending/.`);

  // apply the status refresh IN PLACE to existing matters (auto date fields only)
  let refreshed = 0;
  if (refreshes.length) {
    refreshed = applyFieldUpdates(refreshes);
    log(`Applied ${refreshed} status refresh(es) to data.js.`);
  }

  const wm = { lastRun: todayISO(), lastFiledAfter: filedAfter };
  wm.lastRefresh = refreshes !== null && shouldRefreshRan(args) ? todayISO() : (readWatermark().lastRefresh || null);
  writeJSON(WATERMARK_PATH, wm);
  log(`Next: review with  --review,  then publish with  --approve <id>  /  --approve-all.`);

  if (args.auto) {
    // Autonomous mode (no human-approval gate): publish the staged drafts
    // straight to data.js with their honest pending/unreviewed defaults. The
    // provenance stub summary discloses that merits/gate are not yet reviewed,
    // so nothing here asserts a legal fact. allowStub is implied.
    log(`\n--auto: publishing ${diff.inserts.length} draft(s) to data.js (no review gate)…`);
    approve([], { ...args, approveAll: true, allowStub: true }, repo);   // approve() re-validates the whole file
  } else if (refreshed) {
    revalidate(`status refresh (${refreshed} matter(s))`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`${C.red}ingest error:${C.off} ${e.message}`); process.exit(1); });
}

// Exported for unit tests (the CLI still runs via require.main above).
module.exports = { buildDiff, classify, serializeMatter, applyFieldUpdates, runRefresh };
