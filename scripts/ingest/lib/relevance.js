/* ============================================================================
 *  Relevance gate
 *  ---------------------------------------------------------------------------
 *  A full-text CourtListener search for "Kalshi" / "Polymarket" is NOISY: it
 *  surfaces dockets that merely mention the term (CNN v. Perplexity, Collar v.
 *  Robinhood, Douglas v. National Park Service ...). Publishing those would
 *  pollute the dataset, so every candidate must clear this gate before it can
 *  become a (review-pending) matter. Anything that fails is HELD, not dropped:
 *  it is logged with a reason so a human can rescue a false negative.
 *
 *  Tuned to favor PRECISION over recall — a missed case is a recoverable,
 *  logged miss; a wrong case is visible pollution.
 * ========================================================================== */
"use strict";

// Entities that, if they appear as a party or in the caption, make a docket
// genuinely about prediction-market litigation. Lowercased substrings.
const TARGETS = [
  { platform: "Kalshi", needles: ["kalshi", "kalshiex"] },
  { platform: "Polymarket", needles: ["polymarket", "blockratize"] }, // Blockratize = Polymarket's legal entity
  { platform: "PredictIt", needles: ["predictit", "victoria university of wellington"] },
];

// Entities that frequently co-occur in noise and, alone, are NOT enough.
// (Robinhood/Crypto.com show up in the consolidated 9th Cir. event-contract
//  fight, but only count when a TARGET is also present.)
const SUIT_COMMODITIES = "850"; // nature_of_suit code prefix for Securities/Commodities

function lc(s) { return String(s == null ? "" : s).toLowerCase(); }

/**
 * Decide whether a CourtListener docket record is in-scope.
 * @param {object} d  docket record (caseName, party[], suitNature, court_id ...)
 * @returns {{accept:boolean, platform:string, reason:string}}
 */
function classify(d) {
  const caption = lc(d.caseName || d.case_name || d.case_name_full);
  const parties = Array.isArray(d.party) ? d.party.map(lc) : [];
  const hay = caption + " || " + parties.join(" || ");
  const suit = lc(d.suitNature || d.nature_of_suit);

  // 1) A target entity in the caption or party list — strongest signal.
  for (const t of TARGETS) {
    const hit = t.needles.find((n) => hay.includes(n));
    if (hit) {
      const where = caption.includes(hit) ? "caption" : "party";
      return { accept: true, platform: t.platform, reason: `target "${hit}" in ${where}` };
    }
  }

  // 2) Securities/Commodities suit nature is necessary-but-not-sufficient: only
  //    accept if SOME prediction-market signal is also present (already handled
  //    above for named targets). A bare 850 with no target is held.
  if (suit.startsWith(SUIT_COMMODITIES)) {
    return {
      accept: false,
      platform: "",
      reason: `nature-of-suit 850 but no named prediction-market party — held for review`,
    };
  }

  // 3) Everything else — held with a reason.
  return { accept: false, platform: "", reason: "no prediction-market entity in caption or parties" };
}

module.exports = { classify, TARGETS };
