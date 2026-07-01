/* ============================================================================
 *  livestore — read the LATEST committed forensic data at REQUEST time.
 *  ---------------------------------------------------------------------------
 *  The scan commits data/forensics/*.json to git every ~10 minutes, but the read
 *  APIs bundle those files at BUILD time (require()/includeFiles). That means the
 *  site only shows new data when Vercel REBUILDS — and at 144 data-commits/day the
 *  project blows past the platform's daily deploy cap, so deploys stop mid-day and
 *  every tracker freezes even though git keeps advancing.
 *
 *  Fix: fetch the committed JSON straight from GitHub raw on each request, so the
 *  site reflects each scan tick WITHOUT any rebuild. The repo is public, so no
 *  token is needed. On any failure we fall back to the copy bundled at build time,
 *  so the endpoint degrades honestly instead of erroring.
 *
 *  Pair this with a vercel.json ignoreCommand that skips deploys for data-only
 *  commits — the data no longer needs a deploy, and code deploys keep their budget.
 * ========================================================================== */
"use strict";

// Vercel injects the repo owner/slug at build; fall back to this project's coordinates for local dev.
const OWNER = process.env.VERCEL_GIT_REPO_OWNER || "mgertsik-debug";
const REPO = process.env.VERCEL_GIT_REPO_SLUG || "michael-gertsik";
const RAW = "https://raw.githubusercontent.com/" + OWNER + "/" + REPO + "/main/";
const TIMEOUT_MS = +process.env.LIVE_READ_TIMEOUT_MS || 8000;   // headroom: the cumulative store grows (kept dossiers), and raw fetch of ~12MB needs >3.5s

// Fetch repoRelPath (e.g. "data/forensics/store.json") from GitHub raw and JSON-parse it. Returns the
// parsed object, or the `bundled` fallback (a value or a thunk) on ANY failure — network error,
// non-200, timeout, unparseable body, or a runtime without global fetch.
async function readLive(repoRelPath, bundled) {
  try {
    if (typeof fetch === "function") {
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
      try {
        const r = await fetch(RAW + repoRelPath, Object.assign({ headers: { "User-Agent": "poly-forensics" } }, ctrl ? { signal: ctrl.signal } : {}));
        if (r && r.ok) {
          const j = await r.json();
          if (j && typeof j === "object") return j;
        }
      } finally { if (timer) clearTimeout(timer); }
    }
  } catch (_) { /* fall through to the bundled copy */ }
  try { return typeof bundled === "function" ? bundled() : bundled; } catch (_) { return null; }
}

module.exports = { readLive, RAW };
