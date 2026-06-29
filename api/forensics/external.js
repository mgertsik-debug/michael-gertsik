/* ============================================================================
 *  forensics/external.js — information-environment fetchers (network; scanner-only).
 *  ---------------------------------------------------------------------------
 *  Two public, keyless sources that turn a market's ENTITY (from detectors.extractEntities)
 *  into the inputs the newsBlackout / fedRegister detectors consume:
 *    • GDELT DOC 2.0 — global news article COUNT in a time window (news-blackout).
 *    • Federal Register v1 — recent regulatory documents, PRECISION-FILTERED so only docs
 *      whose TITLE/ABSTRACT actually contain the entity count (kills the fisheries-vs-shipping FP).
 *
 *  Every call is timeout-bounded and returns a safe null/empty on any failure — the detectors
 *  then degrade to no-data rather than fabricating a flag. Used only inside the cron scanner
 *  (where the network is reachable); never imported by the read APIs.
 * ========================================================================== */
"use strict";
const https = require("https");

function getJSON(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const to = setTimeout(() => finish(null), timeoutMs || 4000);
    try {
      const req = https.get(url, { headers: { "User-Agent": "polymarket-forensics/1.0", "Accept": "application/json" } }, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) { res.resume(); clearTimeout(to); return finish(null); }
        let data = "";
        res.on("data", (c) => { data += c; if (data.length > 4e6) req.destroy(); });
        // An HTTP-200 with an EMPTY body is how GDELT signals "zero matching articles" — that is a
        // legitimate result (a news blackout), NOT a failure. Resolve it to {} so the caller reads 0
        // matches, instead of null (which would drop the very case newsBlackout exists to catch).
        res.on("end", () => { clearTimeout(to); const s = data.trim(); if (!s) return finish({}); try { finish(JSON.parse(s)); } catch (_) { finish(null); } });
      });
      req.on("error", () => { clearTimeout(to); finish(null); });
      req.setTimeout(timeoutMs || 4000, () => { req.destroy(); });
    } catch (_) { clearTimeout(to); finish(null); }
  });
}

const pad = (n) => String(n).padStart(2, "0");
function gdeltStamp(sec) {
  const d = new Date(sec * 1000);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
}

/* GDELT DOC 2.0 — number of global news articles matching `entity` (exact phrase) in [fromSec,toSec].
 * Returns an integer count, or null on failure (so newsBlackout stays no-data, never a fake 0). */
async function gdeltArticleCount(entity, fromSec, toSec, opts) {
  opts = opts || {};
  if (!entity || !(fromSec > 0) || !(toSec > fromSec)) return null;
  const phrase = '"' + String(entity).replace(/["\\]/g, "") + '"';
  const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(phrase) +
    "&mode=artlist&maxrecords=75&format=json&sort=datedesc" +
    "&startdatetime=" + gdeltStamp(fromSec) + "&enddatetime=" + gdeltStamp(toSec);
  const j = await getJSON(url, opts.timeoutMs || 4000);
  if (j == null || typeof j !== "object") return null;            // failure → unknown, not zero
  return Array.isArray(j.articles) ? j.articles.length : 0;        // valid empty response → genuine 0 (a blackout)
}

/* Federal Register v1 — recent documents matching the wallet's entities, PRECISION-FILTERED. The
 * `term` search is fuzzy (the FP source), so we post-filter: the specific entity must appear in the
 * document TITLE or ABSTRACT as a substring. Returns { matches:[{title,agency,date,url}], entity }.
 * matches is [] on failure or no precise hit (fedRegister then doesn't fire). */
async function fedRegisterMatches(entities, opts) {
  opts = opts || {};
  const ents = (entities || []).filter((e) => e && String(e).trim().length >= 3).slice(0, 2);
  if (!ents.length) return { matches: [], entity: null };
  const entity = ents[0];                                          // the most-specific entity (extractEntities ranks it first)
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  // anchor the publication window on the BET (resolved bets can be months old); else last windowDays.
  const win = (opts.windowDays || 21) * 86400000;
  const center = opts.anchorSec > 0 ? opts.anchorSec * 1000 : Date.now();
  const gte = day(center - win), lte = day(Math.min(Date.now(), center + 7 * 86400000));
  const url = "https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest" +
    "&conditions%5Bterm%5D=" + encodeURIComponent('"' + entity + '"') +
    "&conditions%5Bpublication_date%5D%5Bgte%5D=" + gte +
    "&conditions%5Bpublication_date%5D%5Blte%5D=" + lte +
    "&fields%5B%5D=title&fields%5B%5D=abstract&fields%5B%5D=publication_date&fields%5B%5D=document_number&fields%5B%5D=html_url&fields%5B%5D=agencies";
  const j = await getJSON(url, opts.timeoutMs || 4000);
  if (j == null || !Array.isArray(j.results)) return { matches: [], entity };
  const lc = entity.toLowerCase();
  const matches = j.results
    .filter((r) => ((r.title || "").toLowerCase().includes(lc) || (r.abstract || "").toLowerCase().includes(lc)))  // PRECISION FILTER
    .slice(0, 5)
    .map((r) => ({
      title: r.title || null,
      agency: (r.agencies && r.agencies[0] && (r.agencies[0].name || r.agencies[0].raw_name)) || null,
      date: r.publication_date || null, url: r.html_url || null,
    }));
  return { matches, entity };
}

module.exports = { gdeltArticleCount, fedRegisterMatches };
