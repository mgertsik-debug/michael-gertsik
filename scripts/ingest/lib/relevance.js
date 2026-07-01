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
 *  logged miss; a wrong case is visible pollution. The gate widened (2026-07)
 *  beyond Kalshi/Polymarket-by-name to the other real event-contract platforms
 *  and to the regulator-vs-state preemption suits that ride alongside them,
 *  because those were being silently HELD (e.g. "Robinhood Derivatives, LLC v.
 *  Dana Nessel", "USA v. Commonwealth of Kentucky").
 * ========================================================================== */
"use strict";

// Entities that, if they appear as a party or in the caption, make a docket
// genuinely about prediction-market litigation. Lowercased substrings.
const TARGETS = [
  { platform: "Kalshi", needles: ["kalshi", "kalshiex"] },
  { platform: "Polymarket", needles: ["polymarket", "blockratize", "qcx"] }, // Blockratize = Polymarket's legal entity; QCX LLC = its CFTC-registered US exchange
  { platform: "PredictIt", needles: ["predictit", "victoria university of wellington"] },
  // Other real event-contract / prediction-market venues. The noisy brand names
  // are scoped to their derivatives/event-contract entity so plain brokerage or
  // crypto dockets don't match. All map to the "Other" platform enum
  // (DATA_CONTRACT allows only Kalshi/Polymarket/PredictIt/Other).
  { platform: "Other", needles: ["robinhood derivatives"] },           // NOT bare "robinhood" (brokerage noise)
  { platform: "Other", needles: ["forecastex"] },                      // Interactive Brokers' event-contract DCM
  { platform: "Other", needles: ["nadex", "north american derivatives exchange"] },
  { platform: "Other", needles: ["foris dax"] },                       // Crypto.com's US derivatives entity
];

// nature_of_suit prefixes that can carry a prediction-market preemption fight.
const SUIT_COMMODITIES = "850"; // Securities/Commodities/Exchanges
const SUIT_STATE_STATUTE = "950"; // Constitutional - State Statute (CFTC/US preemption suits vs. states)

// Companion-case rule inputs. A securities/commodities OR constitutional-state-
// statute docket that pits a financial/gaming regulator (or the United States)
// against a STATE or an event-contract EXCHANGE is in scope even when the caption
// names neither Kalshi nor Polymarket — that is the shape of the CFTC/SEC/state
// preemption & enforcement suits (e.g. "USA v. Commonwealth of Kentucky"). Both
// an enforcer AND a (state | exchange) counterparty must be present, so a bare
// 850/950 with neither still HELDs. These dockets only reach the gate because
// their full text already matched a Kalshi/Polymarket search, so the pairing is
// a strong, precise signal rather than an open door.
const ENFORCERS = [
  "united states", "usa", "u.s.a", "cftc", "commodity futures trading commission",
  "sec", "securities and exchange commission",
  "gaming control board", "ngcb", "division of gaming",
  "gaming commission", "gaming enforcement", "gaming board",
];
const EXCHANGE_CONTEXT = [
  ...TARGETS.flatMap((t) => t.needles),
  "event contract", "event contracts", "prediction market",
  "derivatives exchange", "designated contract market", "dcm",
];
// A state as a party (the "vs. a state" side of a preemption suit).
const STATE_PARTY = /\b(state of|commonwealth of|people of the state|state's attorney)\b/;

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

  // 2) Companion / preemption rule. A Securities/Commodities (850) or
  //    Constitutional-State-Statute (950) docket becomes in-scope when a
  //    financial/gaming regulator (or the United States) is squared off against
  //    a STATE or an event-contract EXCHANGE. Both sides required, so a bare
  //    850/950 with only one still HELDs.
  if (suit.startsWith(SUIT_COMMODITIES) || suit.startsWith(SUIT_STATE_STATUTE)) {
    const enforcer = ENFORCERS.find((r) => hay.includes(r));
    const exch = EXCHANGE_CONTEXT.find((e) => hay.includes(e));
    const stateParty = STATE_PARTY.test(hay);
    if (enforcer && (exch || stateParty)) {
      const other = exch ? `exchange "${exch}"` : "a state";
      return { accept: true, platform: "Other", reason: `${suit.slice(0, 3)} companion: regulator "${enforcer}" vs ${other}` };
    }
    return {
      accept: false,
      platform: "",
      reason: `nature-of-suit ${suit.slice(0, 3)} but no regulator-vs-(state|exchange) pairing — held for review`,
    };
  }

  // 3) Everything else — held with a reason.
  return { accept: false, platform: "", reason: "no prediction-market entity in caption or parties" };
}

module.exports = { classify, TARGETS };
