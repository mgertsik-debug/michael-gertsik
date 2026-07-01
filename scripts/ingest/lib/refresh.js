/* ============================================================================
 *  refresh.js — status-refresh pass for EXISTING tracked matters
 *  ---------------------------------------------------------------------------
 *  The insert path (filed_after) only ever ADDS newly-filed dockets, so the 40+
 *  matters already in data.js never advance once published — a case can be
 *  terminated on PACER for weeks while the tracker still shows "Pending". This
 *  module re-polls each tracked docket and produces HONEST field updates:
 *    - advance `lastUpdate` to the docket's real latest-activity date (clamped
 *      to today, so a future hearing date can never leak in),
 *    - set `decidedDate` when the docket is actually terminated,
 *    - FLAG a newly-terminated matter for human outcome review.
 *  It NEVER invents a merits result: posture/outcome are left for a human, and
 *  matters with no CourtListener docket (news-only sources) are skipped, never
 *  fabricated.
 *
 *  Pure/deterministic except fetchDocketStatus, whose network client is injected
 *  (clGet) so computeRefresh/clampToToday stay trivially unit-testable.
 * ========================================================================== */
"use strict";

const { docketIdOf } = require("./repo");

/** Leading YYYY-MM-DD of a (possibly noisy) date string, or "". */
function isoPrefix(s) {
  const m = String(s == null ? "" : s).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : "";
}

/** Clamp a date to today: strip any suffix, and never return a future date. */
function clampToToday(dateStr, todayISO) {
  const d = isoPrefix(dateStr);
  if (!d) return "";
  return d > todayISO ? todayISO : d;
}

/** The CourtListener docket id for a matter: the id tail (…-cl<id>) or a
 *  /docket/<id>/ URL in its sources. null when the matter has no CL docket. */
function docketIdFromMatter(m) {
  const tail = docketIdOf(m.id);
  if (tail) return tail;
  for (const s of m.sources || []) {
    const mm = String(s).match(/courtlistener\.com\/docket\/(\d+)\//);
    if (mm) return Number(mm[1]);
  }
  return null;
}

/** Fetch a docket's status via the injected clGet(urlPath) client. Returns
 *  { dateModified, dateTerminated, dateLastFiling } (any may be null). */
async function fetchDocketStatus(clGet, docketId) {
  const fields = "id,date_modified,date_terminated,date_last_filing";
  const res = await clGet("/api/rest/v4/dockets/" + docketId + "/?fields=" + encodeURIComponent(fields));
  const o = res && res.results && res.results[0] ? res.results[0] : res || {};
  return {
    dateModified: o.date_modified ? String(o.date_modified) : null,
    dateTerminated: o.date_terminated ? String(o.date_terminated) : null,
    dateLastFiling: o.date_last_filing ? String(o.date_last_filing) : null,
  };
}

/**
 * Compute the HONEST field updates for one matter given its live docket status.
 * @returns {{id, changes:[[field,was,now]], lastUpdate?, decidedDate?, flagOutcome?}}
 */
function computeRefresh(existing, status, todayISO) {
  const changes = [];
  const out = { id: existing.id, changes };

  // 1) lastUpdate -> the docket's real latest-activity date, clamped to today.
  const candidates = [
    isoPrefix(existing.filedDate),
    clampToToday(status.dateLastFiling, todayISO),
    clampToToday(status.dateModified, todayISO),
  ].filter(Boolean);
  const newLast = candidates.slice().sort().pop() || "";
  const curLast = isoPrefix(existing.lastUpdate);
  // Advance if the docket is newer than what we show — OR if the current value
  // is a future/non-ISO date (curLast falsy or > today) that must be repaired.
  const curBadFuture = curLast && curLast > todayISO;
  if (newLast && (!curLast || newLast > curLast || curBadFuture)) {
    changes.push(["lastUpdate", existing.lastUpdate, newLast]);
    out.lastUpdate = newLast;
  }

  // 2) decidedDate -> the termination date, only if actually terminated and unset.
  const term = isoPrefix(status.dateTerminated);
  if (term && !existing.decidedDate) {
    changes.push(["decidedDate", existing.decidedDate, term]);
    out.decidedDate = term;
  }

  // 3) NEVER invent a merits result. A newly-terminated docket that still reads
  //    "Pending" is flagged for a human to set the real outcome/posture.
  if (term && (existing.outcome === "Pending" || existing.posture === "Pending")) {
    out.flagOutcome = true;
  }

  return out;
}

module.exports = { isoPrefix, clampToToday, docketIdFromMatter, fetchDocketStatus, computeRefresh };
