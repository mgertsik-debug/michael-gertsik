/* ============================================================================
 *  repo.js — load the live repo data layer into Node
 *  ---------------------------------------------------------------------------
 *  constants.js / data.js / validate.js are browser IIFEs of the shape
 *      (function (root) { ... })(typeof window !== "undefined" ? window : this)
 *  We execute them against a shared fake `root` so the pipeline reads EXACTLY
 *  what the site reads — the repo stays the single source of truth, and we
 *  never re-declare the schema or the matter list here.
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const PMLE_DIR = path.resolve(__dirname, "../../../models/pmle");

function evalInto(root, file) {
  const code = fs.readFileSync(path.join(PMLE_DIR, file), "utf8");
  // Passing `window=root` makes `typeof window !== "undefined"` true, so each
  // IIFE attaches to our root.PMLE just like it would to the browser window.
  // eslint-disable-next-line no-new-func
  new Function("window", code)(root);
}

/** Load constants + data (+ validator). Returns { PMLE, matters, constants }. */
function loadRepo() {
  const root = {};
  evalInto(root, "constants.js");
  evalInto(root, "data.js");
  evalInto(root, "validate.js");
  const PMLE = root.PMLE || {};
  return { PMLE, matters: PMLE.matters || [], constants: PMLE.constants || {}, root };
}

/** docket_id tail parsed out of a pipeline-created id (…-cl<docketId>). */
function docketIdOf(id) {
  const m = String(id || "").match(/-cl(\d+)$/);
  return m ? Number(m[1]) : null;
}

const DATA_PATH = path.join(PMLE_DIR, "data.js");

module.exports = { loadRepo, docketIdOf, PMLE_DIR, DATA_PATH };
