/* ============================================================================
 *  transform.js — docket record  ->  draft matter object
 *  ---------------------------------------------------------------------------
 *  PURE functions (no I/O, no network) so they are trivially testable. Given a
 *  CourtListener docket record, produce a draft matter that conforms to
 *  models/pmle/DATA_CONTRACT.md. Only VERIFIABLE fields are filled; every field
 *  that requires legal judgment is left at a safe default and named in
 *  `_review.needsReview`. NOTHING here invents a legal fact.
 * ========================================================================== */
"use strict";

const { resolveCourt } = require("./courts");

const CL_BASE = "https://www.courtlistener.com";

// Words we keep cased rather than title-casing.
const KEEP_CASE = {
  llc: "LLC", inc: "Inc.", lp: "LP", llp: "LLP", cftc: "CFTC", sec: "SEC",
  ngcb: "NGCB", usa: "USA", us: "US", kalshiex: "KalshiEX", "kalshiex,": "KalshiEX,",
  ii: "II", iii: "III", na: "N.A.", dba: "d/b/a",
};

function titleCaseWord(w) {
  const bare = w.toLowerCase();
  if (KEEP_CASE[bare]) return KEEP_CASE[bare];
  // keep already-mixed-case tokens (e.g. "KalshiEX", "iPhone") as-is
  if (/[a-z]/.test(w) && /[A-Z]/.test(w)) return w;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** Normalize a caption: title-case ALL-CAPS, fix "v.", collapse whitespace. */
function normalizeCaption(name) {
  let s = String(name || "").replace(/\s+/g, " ").trim();
  if (!s) return s;
  const isShouting = s === s.toUpperCase();
  // normalize the versus token first
  s = s.replace(/\s+v\.?\s+/gi, " v. ").replace(/\s+vs\.?\s+/gi, " v. ");
  if (!isShouting) return s; // mixed-case captions are left alone (already styled)
  return s
    .split(" ")
    .map((w) => (w.toLowerCase() === "v." ? "v." : titleCaseWord(w)))
    .join(" ");
}

/** slugify for ids: lowercase, ascii, dash-separated, max N words. */
function slugify(s, maxWords) {
  const words = String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const stem = (maxWords ? words.slice(0, maxWords) : words).join("-");
  return stem || "matter";
}

/** Stable, unique id: <slug(caption,6)>-cl<docket_id>. */
function makeId(caption, docketId) {
  return `${slugify(caption, 6)}-cl${docketId}`;
}

/** Absolute CourtListener docket URL from a relative absolute_url. */
function docketUrl(d) {
  const rel = d.docket_absolute_url || d.absolute_url || (d.docket_id ? `/docket/${d.docket_id}/` : "");
  if (!rel) return "";
  return rel.startsWith("http") ? rel : CL_BASE + rel;
}

/** Build the provenance-only stub summary (facts only — no characterization). */
function stubSummary(caption, courtLabel, docketNumber, filedDate, ingestDate) {
  const where = courtLabel || "an unspecified court";
  const dn = docketNumber ? ` (docket ${docketNumber})` : "";
  const filed = filedDate ? `Filed ${filedDate} in ${where}${dn}.` : `Filed in ${where}${dn}.`;
  return `NEW FILING — auto-detected from CourtListener on ${ingestDate}. ${filed} ` +
    `Merits, posture, and doctrinal gate not yet reviewed. See source docket.`;
}

/**
 * Transform one docket record into a draft matter + review metadata.
 * @param {object} d        docket record from CourtListener
 * @param {object} ctx      { platform, query, ingestDate }
 * @returns {{matter:object, review:object}}
 */
function toDraftMatter(d, ctx) {
  const ingestDate = ctx.ingestDate;
  const caption = normalizeCaption(d.caseName || d.case_name || d.case_name_full);
  const docketId = d.docket_id != null ? d.docket_id : inferDocketId(d);
  const court = resolveCourt(d.court_id);
  const url = docketUrl(d);

  const parties = (Array.isArray(d.party) ? d.party : [])
    .map((p) => (typeof p === "string" ? p : p && p.name) || "")
    .filter(Boolean)
    .map((name) => ({ name, role: "Unknown" })); // role is NOT in docket metadata

  const states = court.state ? [court.state] : [];

  // Fields that require human legal judgment -> flagged, not invented.
  const needsReview = [];
  if (!ctx.platform) needsReview.push("platform");
  needsReview.push("contractType", "gate", "doctrinalQuestion", "posture", "statutes", "summary");
  if (!court.known) needsReview.push("courtForum", "forum", "states");
  if (parties.length) needsReview.push("parties.role");

  const matter = {
    id: makeId(caption, docketId),
    caption,
    platform: ctx.platform || "Other",
    parties,
    contractType: "Other",                 // honest "unclassified" default — flagged
    forum: court.forum || "Federal court", // best-effort — flagged if court unknown
    courtForum: court.label || String(d.court_id || ""),
    docketNumber: d.docketNumber || d.docket_number || "",
    states,
    statutes: [],                          // not in metadata — flagged
    gate: "special",                       // neutral default: the dominant bucket
                                           // (gaming/enumerated). Flagged; summary
                                           // discloses it is unreviewed.
    doctrinalQuestion: "Not yet reviewed — see source docket.", // honest placeholder, flagged
    posture: "Pending",                    // safe default for an open docket — flagged
    outcome: d.dateTerminated ? "Pending" : "Pending", // termination != merits; stays Pending until review
    filedDate: d.dateFiled || d.date_filed || "",
    decidedDate: d.dateTerminated || d.date_terminated || null,
    lastUpdate: ingestDate,
    summary: stubSummary(caption, court.label, d.docketNumber, d.dateFiled, ingestDate),
    sources: [url].filter(Boolean),
  };

  const review = {
    status: "pending",
    needsReview,
    courtKnown: court.known,
    provenance: {
      docketId,
      docketUrl: url,
      courtId: d.court_id || "",
      query: ctx.query || "",
      suitNature: d.suitNature || "",
      ingestedAt: ingestDate,
    },
  };

  return { matter, review };
}

/** Best-effort docket_id from an absolute_url like /docket/73481299/...  */
function inferDocketId(d) {
  const u = d.docket_absolute_url || d.absolute_url || "";
  const m = u.match(/\/docket\/(\d+)\//);
  return m ? Number(m[1]) : null;
}

module.exports = {
  normalizeCaption, slugify, makeId, docketUrl, stubSummary,
  toDraftMatter, inferDocketId, CL_BASE,
};
