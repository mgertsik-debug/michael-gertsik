/* ============================================================================
 *  court_id -> { state, forum, label }
 *  ---------------------------------------------------------------------------
 *  CourtListener identifies every docket by a short `court_id` (e.g. "nysd").
 *  This map turns that into the three things the matter schema needs:
 *    - state : USPS code that must exist in constants.js -> TILES (or "" )
 *    - forum : one of the controlled `FORUMS` enum values
 *    - label : the human court string we put in `courtForum`
 *
 *  This is DATA, not logic. To support a new court, add one line here; do not
 *  touch transform.js. Anything not listed is handled gracefully by
 *  resolveCourt() below (state "", raw id as label, flagged upstream).
 *
 *  Circuit courts and agency dockets intentionally map to state "" — an appeal
 *  or an agency action is not pinned to one state on the cartogram; a human
 *  adds the appeal chain on review.
 * ========================================================================== */
"use strict";

// Federal district courts -> their state. (The common ones; extend as needed.)
const DISTRICT = {
  // A
  almd: "AL", alnd: "AL", alsd: "AL", akd: "AK", azd: "AZ", ared: "AR", arwd: "AR",
  // C
  cacd: "CA", caed: "CA", cand: "CA", casd: "CA", cod: "CO", ctd: "CT",
  // D
  ded: "DE", dcd: "DC",
  // F
  flmd: "FL", flnd: "FL", flsd: "FL",
  // G
  gamd: "GA", gand: "GA", gasd: "GA",
  // H/I
  hid: "HI", idd: "ID", ilcd: "IL", ilnd: "IL", ilsd: "IL", innd: "IN", insd: "IN",
  iand: "IA", iasd: "IA",
  // K
  ksd: "KS", kyed: "KY", kywd: "KY",
  // L
  laed: "LA", lamd: "LA", lawd: "LA",
  // M
  med: "ME", mdd: "MD", mad: "MA", mied: "MI", miwd: "MI", mnd: "MN",
  msnd: "MS", mssd: "MS", moed: "MO", mowd: "MO", mtd: "MT",
  // N
  ned: "NE", nvd: "NV", nhd: "NH", njd: "NJ", nmd: "NM",
  nyed: "NY", nynd: "NY", nysd: "NY", nywd: "NY",
  nced: "NC", ncmd: "NC", ncwd: "NC", ndd: "ND",
  // O
  ohnd: "OH", ohsd: "OH", oked: "OK", oknd: "OK", okwd: "OK", ord: "OR",
  // P
  paed: "PA", pamd: "PA", pawd: "PA", prd: "PR", rid: "RI",
  // S
  scd: "SC", sdd: "SD",
  // T
  tned: "TN", tnmd: "TN", tnwd: "TN",
  txed: "TX", txnd: "TX", txsd: "TX", txwd: "TX",
  // U
  utd: "UT",
  // V
  vtd: "VT", vaed: "VA", vawd: "VA",
  // W
  waed: "WA", wawd: "WA", wvnd: "WV", wvsd: "WV", wied: "WI", wiwd: "WI", wyd: "WY",
};

// Human labels for the district ids above (only those that differ from a simple
// upcase; we generate a reasonable default for the rest in resolveCourt()).
const DISTRICT_LABEL = {
  nysd: "S.D.N.Y.", nyed: "E.D.N.Y.", nynd: "N.D.N.Y.", nywd: "W.D.N.Y.",
  cand: "N.D. Cal.", cacd: "C.D. Cal.", caed: "E.D. Cal.", casd: "S.D. Cal.",
  dcd: "D.D.C.", njd: "D.N.J.", nvd: "D. Nev.", mdd: "D. Md.", mnd: "D. Minn.",
  ohsd: "S.D. Ohio", ohnd: "N.D. Ohio", nmd: "D.N.M.", ilnd: "N.D. Ill.",
  txsd: "S.D. Tex.", txnd: "N.D. Tex.", txwd: "W.D. Tex.", txed: "E.D. Tex.",
  flsd: "S.D. Fla.", flmd: "M.D. Fla.", flnd: "N.D. Fla.", paed: "E.D. Pa.",
  mad: "D. Mass.", kyed: "E.D. Ky.", kywd: "W.D. Ky.", vaed: "E.D. Va.",
  ctd: "D. Conn.", cod: "D. Colo.", ksd: "D. Kan.", rid: "D.R.I.",
};

// Courts of appeals -> human label (no state on the cartogram).
const CIRCUIT_LABEL = {
  ca1: "1st Cir.", ca2: "2d Cir.", ca3: "3d Cir.", ca4: "4th Cir.",
  ca5: "5th Cir.", ca6: "6th Cir.", ca7: "7th Cir.", ca8: "8th Cir.",
  ca9: "9th Cir.", ca10: "10th Cir.", ca11: "11th Cir.", cadc: "D.C. Cir.",
  cafc: "Fed. Cir.", scotus: "U.S. Supreme Court",
};

/**
 * Resolve a CourtListener court_id to { state, forum, label, known }.
 * Never throws; unknown ids return known:false so callers can flag.
 */
function resolveCourt(courtId) {
  const id = String(courtId || "").trim().toLowerCase();
  if (!id) return { state: "", forum: "", label: "", known: false };

  if (DISTRICT[id]) {
    return {
      state: DISTRICT[id],
      forum: "Federal court",
      label: DISTRICT_LABEL[id] || id.toUpperCase(),
      known: true,
    };
  }
  if (CIRCUIT_LABEL[id]) {
    return { state: "", forum: "Federal court", label: CIRCUIT_LABEL[id], known: true };
  }
  // Unknown court — surface the raw id, leave state empty, mark unknown.
  return { state: "", forum: "", label: id, known: false };
}

module.exports = { resolveCourt, DISTRICT, DISTRICT_LABEL, CIRCUIT_LABEL };
