#!/usr/bin/env node
/* ============================================================================
 *  Insider-trading Tracker ingest — CFTC press releases (primary) + CourtListener
 *  ---------------------------------------------------------------------------
 *  Keeps the Insider Trading model's Tracker live. Most of this tracker is
 *  CFTC-sourced (press releases announcing enforcement / advisories), so CFTC
 *  is the PRIMARY feed; CourtListener is SECONDARY (precise docket links/dates
 *  for matters that become federal cases). Everything is keyword-gated to
 *  prediction-market insider-trading so unrelated items never land.
 *
 *  Auto mode (the scheduled default) splices matches straight into
 *  models/insider-trading.html via scripts/ingest/insider-tracker.js and lets
 *  the GitHub Action commit the result. The splicer leaves existing rows
 *  byte-for-byte intact and dedupes on docket/PR id, so re-runs are idempotent.
 *
 *  Zero dependencies (vanilla Node >=18). Both sources are best-effort: if one
 *  is unreachable (CFTC.gov WAF, etc.) the run logs it and continues on the
 *  other rather than failing.
 *
 *  USAGE
 *    node scripts/ingest/insider.js --dry-run     # show proposed rows, write nothing
 *    node scripts/ingest/insider.js --auto        # splice + (Action) commit
 *    node scripts/ingest/insider.js --cftc-fixture <f> --cl-fixture <f>   # offline
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spliceSection, MODEL_PATH } = require("./insider-tracker");

const INGEST_DIR = path.resolve(__dirname, "../../data/ingest");
const SEEN_PATH = path.join(INGEST_DIR, "insider-seen.json");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* -------- relevance: only prediction-market insider-trading items ---------- */
// An item must mention at least one of these to be in-scope for THIS model.
const SCOPE_KW = [
  "prediction market", "event contract", "kalshi", "polymarket", "180.1",
  "insider", "misappropriat", "eddie murphy", "van dyke", "spagnuolo",
  "year in search", "maduro",
];
// Within scope, these mark an ENFORCEMENT action (vs a regulatory item).
const ENFORCE_KW = [
  "charg", "indict", "complaint", "order instituting", "settl", "fined",
  "penalt", "insider", "misappropriat", "fraud", "manipulat", "disgorge",
];
const lc = (s) => String(s == null ? "" : s).toLowerCase();
const inScope = (t) => SCOPE_KW.some((k) => lc(t).includes(k));
const isEnforcement = (t) => ENFORCE_KW.some((k) => lc(t).includes(k));

/* ------------------------------------------------------------------ args --- */
function parseArgs(argv) {
  const a = { dryRun: false, auto: false, cftcFixture: null, clFixture: null, days: 120 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run") a.dryRun = true;
    else if (t === "--auto") a.auto = true;
    else if (t === "--cftc-fixture") a.cftcFixture = argv[++i];
    else if (t === "--cl-fixture") a.clFixture = argv[++i];
    else if (t === "--days") a.days = parseInt(argv[++i], 10) || 120;
  }
  return a;
}

/* ----------------------------------------------------------------- dates --- */
function fmtISO(d) { return d.toISOString().slice(0, 10); }
function fmtNice(d) { return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`; }
function todayISO() { return new Date().toISOString().slice(0, 10); }

/* ----------------------------------------------------------------- http ---- */
function get(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { method: "GET", hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({ "User-Agent": "Mozilla/5.0 (compatible; pmle-tracker/1.0)", Accept: "*/*" }, headers || {}) };
    https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location, headers));
      }
      let body = ""; res.on("data", (c) => (body += c));
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300
        ? resolve(body) : reject(new Error("HTTP " + res.statusCode + " for " + url))));
    }).on("error", reject);
  });
}

/* =================================== CFTC ================================== */
// Candidate press-release feeds (first that returns XML wins). CFTC.gov sits
// behind a WAF that 403s some networks; if all fail the run continues on CL.
const CFTC_FEEDS = [
  "https://www.cftc.gov/RSS/RSSGP/rssgp.xml",
  "https://www.cftc.gov/RSS/RSSENF/rssenf.xml",
  "https://www.cftc.gov/RSS/RSSPR/rsspr.xml",
];

function unescapeXml(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function parseRss(xml) {
  const items = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const pick = (tag) => { const mm = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i").exec(block); return mm ? unescapeXml(mm[1]) : ""; };
    items.push({ title: pick("title"), link: pick("link"), pubDate: pick("pubDate"), desc: pick("description") });
  }
  return items;
}

async function gatherCFTC(args) {
  let xml = null;
  if (args.cftcFixture) {
    xml = fs.readFileSync(path.resolve(args.cftcFixture), "utf8");
  } else {
    for (const f of CFTC_FEEDS) {
      try { xml = await get(f); if (xml && xml.includes("<item")) break; } catch (e) { /* try next */ }
    }
  }
  if (!xml) { console.warn("CFTC: no feed reachable (WAF/403?) — skipping CFTC this run."); return []; }
  const cutoff = new Date(Date.now() - args.days * 86400000);
  const rows = [];
  for (const it of parseRss(xml)) {
    const text = it.title + " " + it.desc;
    if (!inScope(text)) continue;
    const dt = it.pubDate ? new Date(it.pubDate) : null;
    if (dt && !isNaN(dt) && dt < cutoff) continue;
    const enf = isEnforcement(text);
    rows.push({
      section: enf ? "enforcement" : "regulatory",
      d: dt && !isNaN(dt) ? fmtISO(dt) : todayISO(),
      date: dt && !isNaN(dt) ? fmtNice(dt) : "verify",
      actors: deriveActors(it.title),
      sum: trim(it.title, 150),
      src: it.link || "cftc.gov/PressRoom",
      status: enf ? (lc(text).includes("settl") || lc(text).includes("penalt") ? "Settled/penalty" : "Charged") : "Regulatory",
      sc: enf ? (lc(text).includes("settl") || lc(text).includes("penalt") ? "amber" : "red") : "emerald",
    });
  }
  return rows;
}

function deriveActors(title) {
  const t = String(title || "");
  const v = t.match(/([A-Z][\w.&'-]+(?:\s+[A-Z][\w.&'-]+)*)\s+v\.?\s+([A-Z][\w.&'-]+(?:\s+[A-Z][\w.&'-]+)*)/);
  if (v) return trim(v[0], 60);
  if (/CFTC/i.test(t)) return "CFTC";
  return trim(t.split(/[:—-]/)[0], 50) || "CFTC";
}
function trim(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

/* =============================== CourtListener ============================= */
const CL_FIELDS = ["docket_id", "caseName", "docketNumber", "court_id", "dateFiled", "dateTerminated", "suitNature", "docket_absolute_url", "party"];
const CL_QUERIES = ["Van Dyke prediction", "Spagnuolo", "insider trading event contract", "180.1 prediction market"];

function clGet(urlPath) {
  const token = process.env.COURTLISTENER_API_TOKEN;
  return new Promise((resolve, reject) => {
    const opts = { hostname: "www.courtlistener.com", path: urlPath, method: "GET",
      headers: { "User-Agent": "pmle-tracker", Accept: "application/json" } };
    if (token) opts.headers.Authorization = "Token " + token;
    https.get(opts, (res) => { let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(JSON.parse(b)) : reject(new Error("CL HTTP " + res.statusCode)))); }).on("error", reject);
  });
}

// Relevance: a target name in the caption, or a CFTC/USA-v-individual docket
// whose caption is in scope. Precision over recall — a missed case is recoverable.
function clRelevant(d) {
  const cap = lc(d.caseName);
  const parties = (Array.isArray(d.party) ? d.party : []).map(lc).join(" | ");
  if (/van dyke|spagnuolo/.test(cap + " " + parties)) return true;
  const govt = /commodity futures trading commission|cftc|united states/.test(parties);
  return govt && inScope(cap);
}

async function gatherCL(args) {
  let records = [];
  if (args.clFixture) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(args.clFixture), "utf8"));
    records = Array.isArray(raw) ? raw : (raw.results || []);
  } else if (process.env.COURTLISTENER_API_TOKEN) {
    const filedAfter = fmtISO(new Date(Date.now() - args.days * 86400000));
    for (const q of CL_QUERIES) {
      try {
        const params = new URLSearchParams({ type: "d", q, order_by: "dateFiled desc", filed_after: filedAfter });
        CL_FIELDS.forEach((f) => params.append("fields", f));
        const page = await clGet("/api/rest/v4/search/?" + params.toString());
        (page.results || []).forEach((r) => records.push(r));
      } catch (e) { console.warn("CL query failed (" + q + "): " + e.message); }
    }
  } else {
    console.warn("CL: no COURTLISTENER_API_TOKEN and no fixture — skipping CourtListener this run.");
    return [];
  }
  const rows = [];
  const seenDoc = new Set();
  for (const d of records) {
    if (!clRelevant(d)) continue;
    if (d.docket_id != null) { if (seenDoc.has(d.docket_id)) continue; seenDoc.add(d.docket_id); }
    const dt = d.dateFiled ? new Date(d.dateFiled + "T00:00:00Z") : null;
    const url = d.docket_absolute_url ? "https://www.courtlistener.com" + d.docket_absolute_url : "";
    rows.push({
      section: "enforcement",
      d: d.dateFiled || todayISO(),
      date: dt && !isNaN(dt) ? fmtNice(dt) : "verify",
      actors: trim(d.caseName, 60),
      sum: "Event-contract enforcement docket (" + (d.docketNumber || "verify") + "); details pending review.",
      src: url || "courtlistener.com",
      status: "Charged",
      sc: "red",
    });
  }
  return rows;
}

/* =================================== main ================================= */
async function main() {
  const args = parseArgs(process.argv);
  const seen = readJSON(SEEN_PATH, { keys: [] });

  const [cftc, cl] = await Promise.all([gatherCFTC(args), gatherCL(args)]);
  const all = cftc.concat(cl);
  const enforcement = all.filter((r) => r.section === "enforcement");
  const regulatory = all.filter((r) => r.section === "regulatory");

  console.log(`\nInsider tracker ingest — CFTC rows: ${cftc.length}, CourtListener rows: ${cl.length}`);
  console.log(`  enforcement candidates: ${enforcement.length}, regulatory candidates: ${regulatory.length}\n`);

  let text = fs.readFileSync(MODEL_PATH, "utf8");
  const addedAll = [];
  for (const [key, rows] of [["enforcement", enforcement], ["regulatory", regulatory]]) {
    if (!rows.length) continue;
    const res = spliceSection(text, key, rows, seen.keys);
    res.added.forEach((r) => { addedAll.push(r); seen.keys.push(require("./insider-tracker").rowKey(r)); });
    text = res.text;
    res.added.forEach((r) => console.log(`  + [${key}] ${r.date}  ${r.actors}  ${r.sc.toUpperCase()}\n      ${r.sum}\n      ${r.src}`));
  }

  if (!addedAll.length) { console.log("No new rows. Tracker already current."); return; }

  if (args.dryRun) { console.log(`\n--dry-run: ${addedAll.length} new row(s) proposed; nothing written.`); return; }

  fs.writeFileSync(MODEL_PATH, text);
  writeJSON(SEEN_PATH, { updatedAt: todayISO(), keys: seen.keys });
  console.log(`\nPublished ${addedAll.length} new row(s) into models/insider-trading.html.`);
}

function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fb; } }
function writeJSON(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n"); }

main().catch((e) => { console.error("insider ingest error:", e.message); process.exit(1); });
