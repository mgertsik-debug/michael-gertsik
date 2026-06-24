/* ============================================================================
 *  Insider-trading Tracker — enforcement-row splicer (the mechanical core)
 *  ---------------------------------------------------------------------------
 *  The Insider Trading model (models/insider-trading.html) is a self-contained
 *  Design Component; its Tracker data lives in an inline `enforcement:[ ... ]`
 *  array inside the x-dc <script>. This module locates that array, parses the
 *  existing rows, and splices NEW rows in at the top — in the file's exact
 *  one-row-per-line house style — without disturbing anything else.
 *
 *  It is source-agnostic: feed it tracker-row objects from CourtListener, a
 *  CFTC press-release feed, or anything else. PURE string + parse functions so
 *  it is testable offline (see --selftest), which matters because the live
 *  sources (CFTC.gov, news feeds) block automated fetches and CourtListener is
 *  API/token-gated — the row plumbing must be provably correct on its own.
 *
 *  Row shape (matches the seeded rows exactly):
 *    { d:'YYYY-MM-DD', date:'Mon DD YYYY', actors:'…', sum:'…', src:'…',
 *      status:'…', sc:'red'|'amber'|'emerald'|'muted' }
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const MODEL_PATH = path.resolve(__dirname, "../../models/insider-trading.html");

/** Find a `<key>:[ … ]` array body inside the model file (key e.g. "enforcement"
 *  or "regulatory"). Returns { pre, body, post }; bracket-counted so nested
 *  […] inside strings can't fool it. */
function locateArray(text, key) {
  const anchor = key + ":[";
  const at = text.indexOf(anchor);
  if (at === -1) throw new Error(anchor + " not found in model file");
  const open = at + anchor.length - 1;            // index of '['
  let depth = 0, i = open, inStr = false, q = "";
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === q) inStr = false;
      continue;
    }
    if (c === "'" || c === '"') { inStr = true; q = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error("unbalanced " + anchor);
  return { pre: text.slice(0, open + 1), body: text.slice(open + 1, i), post: text.slice(i) };
}

/** Back-compat: the enforcement array specifically. */
function locateEnforcement(text) { return locateArray(text, "enforcement"); }

/** Parse the row objects out of an array body. Tolerant: pulls each top-level
 *  { … } and reads its single-quoted string fields. */
function parseRows(body) {
  const rows = [];
  let depth = 0, start = -1, inStr = false, q = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (c === "\\") { i++; continue; } if (c === q) inStr = false; continue; }
    if (c === "'" || c === '"') { inStr = true; q = c; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0) rows.push(body.slice(start, i + 1)); }
  }
  return rows.map((src) => ({ src, fields: readFields(src) }));
}

function readFields(objSrc) {
  const f = {};
  const re = /(\w+)\s*:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(objSrc))) f[m[1]] = m[2].replace(/\\'/g, "'");
  return f;
}

/** Serialize a row object to the file's exact style (6-space indent). */
function serializeRow(r) {
  const esc = (s) => String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const parts = ["d", "date", "actors", "sum", "src", "status", "sc"]
    .map((k) => `${k}:'${esc(r[k])}'`).join(", ");
  return `      { ${parts} }`;
}

/** A stable dedupe key for a row: prefer an explicit docket/PR id, else the
 *  normalized actors string. */
function rowKey(r) {
  const src = String(r.src || "");
  const dk = src.match(/docket\/(\d+)\//);
  if (dk) return "cl" + dk[1];
  const pr = src.match(/\b(\d{3,5}-\d{2})\b/);          // CFTC PR number e.g. 9217-26
  if (pr) return "pr" + pr[1];
  return "actor:" + String(r.actors || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Splice new rows at the TOP of a section's array (default "enforcement"),
 *  newest-first, skipping any whose key already appears among existing rows or
 *  in `seenKeys`. Returns { text, added:[…] }. */
function spliceSection(text, key, newRows, seenKeys) {
  const { pre, body, post } = locateArray(text, key);
  const existing = parseRows(body);
  const have = new Set(seenKeys || []);
  existing.forEach((e) => have.add(rowKey(e.fields)));

  const fresh = [];
  for (const r of newRows) {
    const k = rowKey(r);
    if (have.has(k)) continue;
    have.add(k);
    fresh.push(r);
  }
  if (!fresh.length) return { text, added: [] };

  // newest first within this batch
  fresh.sort((a, b) => String(b.d).localeCompare(String(a.d)));
  const block = "\n" + fresh.map(serializeRow).join(",\n") + ",";
  // insert right after the '[' (pre ends with '['); existing body follows
  return { text: pre + block + body + post, added: fresh };
}

/** Back-compat: splice into the enforcement section. */
function spliceRows(text, newRows, seenKeys) { return spliceSection(text, "enforcement", newRows, seenKeys); }

module.exports = { locateArray, locateEnforcement, parseRows, readFields, serializeRow, rowKey, spliceSection, spliceRows, MODEL_PATH };

/* ----------------------------- self-test --------------------------------- */
if (require.main === module && process.argv.includes("--selftest")) {
  const text = fs.readFileSync(MODEL_PATH, "utf8");
  const { body } = locateEnforcement(text);
  const rows = parseRows(body);
  console.log("located enforcement array; existing rows:", rows.length);
  rows.forEach((r) => console.log("  -", r.fields.date, "|", r.fields.actors, "| key", rowKey(r.fields)));

  // round-trip: re-serialize each existing row and confirm fields survive
  let ok = true;
  rows.forEach((r) => {
    const re = readFields(serializeRow(r.fields));
    ["d", "date", "actors", "sum", "src", "status", "sc"].forEach((k) => {
      if ((re[k] || "") !== (r.fields[k] || "")) { ok = false; console.log("    MISMATCH", k); }
    });
  });
  console.log("round-trip fields preserved:", ok);

  // dedupe: splicing the existing rows back in must add ZERO
  const dup = spliceRows(text, rows.map((r) => r.fields), []);
  console.log("re-splicing existing rows adds:", dup.added.length, "(expect 0)");

  // add one synthetic new row, confirm it lands and the file still parses
  const test = spliceRows(text, [{ d: "2026-06-30", date: "Jun 30 2026", actors: "TEST v. Example", sum: "synthetic self-test row.", src: "https://www.courtlistener.com/docket/99999999/test/", status: "Charged", sc: "red" }], []);
  const after = parseRows(locateEnforcement(test.text).body);
  console.log("after adding 1 synthetic row, total rows:", after.length, "(expect", rows.length + 1 + ")");
  console.log("synthetic row at top:", after[0].fields.actors === "TEST v. Example");
}
