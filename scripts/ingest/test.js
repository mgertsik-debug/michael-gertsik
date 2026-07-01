#!/usr/bin/env node
/* ============================================================================
 *  Unit tests for the ingest pipeline's pure logic — relevance gate + status
 *  refresh. Zero dependencies; run with:  node scripts/ingest/test.js
 *  Exits non-zero on any failure so CI / a pre-commit hook can gate on it.
 * ========================================================================== */
"use strict";
const assert = require("assert");
const { classify } = require("./lib/relevance");
const { clampToToday, computeRefresh, isoPrefix, docketIdFromMatter } = require("./lib/refresh");

let n = 0, fails = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log("  ok  " + name); }
  catch (e) { fails++; console.log("FAIL  " + name + "\n        " + e.message); }
}

/* ---------------------------------------------------------- relevance ----- */
const D = (caseName, party, suitNature) => ({ caseName, party, suitNature });

test("accepts Kalshi by caption", () => assert.equal(classify(D("KalshiEX LLC v. Raoul", ["KalshiEX LLC"], "")).accept, true));
test("accepts Polymarket entity QCX", () => assert.equal(classify(D("QCX LLC v. Torrez", ["QCX LLC", "Raul Torrez"], "")).platform, "Polymarket"));
test("accepts Robinhood Derivatives (event contracts)", () => {
  const r = classify(D("Robinhood Derivatives, LLC v. Dana Nessel", ["Robinhood Derivatives, LLC"], "3850 Securities"));
  assert.equal(r.accept, true); assert.equal(r.platform, "Other");
});
test("does NOT accept bare Robinhood brokerage", () => assert.equal(classify(D("Doe v. Robinhood Markets, Inc.", ["Robinhood Markets, Inc."], "3190 Contract")).accept, false));
test("accepts USA-v-state 950 companion", () => assert.equal(classify(D("USA v. Commonwealth of Kentucky", ["United States of America", "Commonwealth of Kentucky"], "950 Constitutional - State Statute")).accept, true));
test("accepts CFTC-vs-state 850 companion", () => assert.equal(classify(D("CFTC v. State of X", ["Commodity Futures Trading Commission", "State of X"], "850 Securities")).accept, true));
test("holds bare 850 with no regulator/state/exchange", () => assert.equal(classify(D("Acme v. Beta", ["Acme", "Beta"], "850 Securities")).accept, false));
test("holds pure keyword noise (CNN v. Perplexity)", () => assert.equal(classify(D("Cable News Network v. Perplexity AI", ["CNN", "Perplexity"], "820 Copyright")).accept, false));
test("holds CFTC-vs-individual (not a state/exchange)", () => assert.equal(classify(D("CFTC v. Spagnuolo", ["Commodity Futures Trading Commission", "John Spagnuolo"], "850 Securities")).accept, false));

/* ----------------------------------------------------------- refresh ------ */
const T = "2026-07-01";
test("clampToToday strips non-ISO suffix", () => assert.equal(clampToToday("2026-06-24 (args set)", T), "2026-06-24"));
test("clampToToday clamps a future date to today", () => assert.equal(clampToToday("2026-07-22 (TRO hearing)", T), T));
test("clampToToday parses a datetime to its date", () => assert.equal(clampToToday("2026-06-29T14:52:39-07:00", T), "2026-06-29"));
test("isoPrefix of a plain date", () => assert.equal(isoPrefix("2026-06-24"), "2026-06-24"));

test("computeRefresh advances lastUpdate + sets decidedDate + flags outcome on termination", () => {
  const m = { id: "x", filedDate: "2026-03-05", lastUpdate: "2026-06-24", decidedDate: null, outcome: "Pending", posture: "Pending" };
  const s = { dateModified: "2026-06-29T14:52:39-07:00", dateTerminated: "2026-06-25", dateLastFiling: "2026-06-26" };
  const r = computeRefresh(m, s, T);
  assert.equal(r.lastUpdate, "2026-06-29");
  assert.equal(r.decidedDate, "2026-06-25");
  assert.equal(r.flagOutcome, true);
});
test("computeRefresh repairs a FUTURE lastUpdate even without new activity", () => {
  const m = { id: "y", filedDate: "2026-05-20", lastUpdate: "2026-07-22 (TRO hearing)", decidedDate: null, outcome: "Pending", posture: "Pending" };
  const s = { dateModified: "2026-06-20T00:00:00Z", dateTerminated: null, dateLastFiling: "2026-06-18" };
  const r = computeRefresh(m, s, T);
  assert.equal(r.lastUpdate, "2026-06-20");
  assert.equal(r.decidedDate, undefined);
  assert.ok(!r.flagOutcome);
});
test("computeRefresh is a no-op when the matter is already current", () => {
  const m = { id: "z", filedDate: "2026-06-01", lastUpdate: "2026-06-30", decidedDate: null, outcome: "Pending", posture: "Pending" };
  const s = { dateModified: "2026-06-20T00:00:00Z", dateTerminated: null, dateLastFiling: "2026-06-20" };
  assert.equal(computeRefresh(m, s, T).changes.length, 0);
});
test("computeRefresh never overwrites an existing decidedDate", () => {
  const m = { id: "w", filedDate: "2026-01-01", lastUpdate: "2026-06-01", decidedDate: "2026-05-01", outcome: "Settled", posture: "Decided" };
  const s = { dateModified: "2026-06-10T00:00:00Z", dateTerminated: "2026-05-02", dateLastFiling: "2026-06-05" };
  const r = computeRefresh(m, s, T);
  assert.equal(r.decidedDate, undefined);     // already set — untouched
  assert.ok(!r.flagOutcome);                  // outcome already human-set (not "Pending")
});

test("docketIdFromMatter reads the id tail", () => assert.equal(docketIdFromMatter({ id: "kalshiex-llc-v-raoul-cl73522956", sources: [] }), 73522956));
test("docketIdFromMatter falls back to a /docket/<id>/ source", () => assert.equal(docketIdFromMatter({ id: "no-tail", sources: ["https://www.courtlistener.com/docket/12345/x/"] }), 12345));
test("docketIdFromMatter returns null for a news-only matter", () => assert.equal(docketIdFromMatter({ id: "no-tail", sources: ["https://example.com/story"] }), null));

console.log("\n" + (n - fails) + "/" + n + " passed" + (fails ? ("  — " + fails + " FAILED") : ""));
process.exit(fails ? 1 : 0);
