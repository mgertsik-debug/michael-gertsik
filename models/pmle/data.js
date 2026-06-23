/* ============================================================================
 *  PREDICTION MARKET LITIGATION EXPLORER  ·  DATA  (the matters)
 *  ---------------------------------------------------------------------------
 *  THIS is the file you edit. Every lens, the search, and the simulator read
 *  from the single array below. There is no case data anywhere else.
 *
 *  To add a case:  copy one object, paste it at the TOP of the array, edit it.
 *  To go live:     delete every object below, set PMLE.SAMPLE_DATA = false,
 *                  and the "SAMPLE DATA" banner disappears on its own.
 *
 *  Field meanings, allowed values, and how `gate` maps to the doctrine flow
 *  are documented in  models/pmle/HOW_TO_ADD_A_CASE.md.  The validator
 *  (validate.js) will warn in the console if a record is malformed, naming
 *  the offending `id`, so bad data can never silently break the UI.
 *
 *  SCHEMA (every field required unless noted):
 *    id            string   stable, unique slug
 *    caption       string   short title shown everywhere
 *    platform      enum     Kalshi | Polymarket | PredictIt | Other
 *    parties       array    [{ name, role }, ...]
 *    contractType  enum     Election | Sports | Economic indicator | Cultural | Other
 *    forum         enum     CFTC | SEC | State gaming regulator | Federal court | State court
 *    states        array    USPS codes, e.g. ['NJ','NY']; [] if purely federal
 *    statutes      array    strings, e.g. ['CEA §5c(c)']
 *    gate          enum     swap | special | howey | cleared  (doctrine gate it turned on)
 *    doctrinalQuestion string  the one-line question the matter posed
 *    posture       enum     Enjoined | Regulator action | Pending | Permitted | Settled | Dismissed
 *    outcome       enum     Pending | Enjoined | Permitted | Settled | Dismissed
 *    filedDate     string   ISO 'YYYY-MM-DD'
 *    decidedDate   string   ISO 'YYYY-MM-DD'  OR  null if ongoing
 *    summary       string   1-3 sentences
 *    sources       array    strings (citations / docket nos / links)
 * ========================================================================== */
(function (root) {
  "use strict";
  const PMLE = (root.PMLE = root.PMLE || {});

  /* ---------------------------------------------------------------------- *
   *  SAMPLE / PLACEHOLDER DATA.
   *  Flip this to false (and replace the array) when real data is ready.
   *  While true, the UI shows a "SAMPLE DATA" banner.
   * ---------------------------------------------------------------------- */
  PMLE.SAMPLE_DATA = true;

  PMLE.matters = [

    { id: "m1", caption: "Kalshi v. CFTC (Election Contracts)", platform: "Kalshi",
      parties: [{ name: "KalshiEX LLC", role: "Plaintiff" }, { name: "CFTC", role: "Defendant" }],
      contractType: "Election", forum: "Federal court", states: ["DC"],
      statutes: ["CEA §5c(c)", "7 U.S.C. §7a-2"], gate: "special",
      doctrinalQuestion: 'Do congressional-control event contracts involve unlawful "gaming"?',
      posture: "Permitted", outcome: "Permitted", filedDate: "2023-11-01", decidedDate: "2024-10-02",
      summary: "Court held the exchange could list election contracts; agency lacked authority to bar them as gaming/unlawful activity under the special rule.",
      sources: ["Sample docket no. 1:23-cv-0000", "Sample D.C. Cir. order"] },

    { id: "m2", caption: "In re Polymarket (CFTC Settlement)", platform: "Polymarket",
      parties: [{ name: "CFTC", role: "Regulator" }, { name: "Blockratize, Inc.", role: "Respondent" }],
      contractType: "Election", forum: "CFTC", states: [],
      statutes: ["CEA §4(a)", "17 C.F.R. §38"], gate: "swap",
      doctrinalQuestion: "Were the event contracts unregistered swaps offered off a designated exchange?",
      posture: "Regulator action", outcome: "Settled", filedDate: "2022-01-03", decidedDate: "2022-01-03",
      summary: "Consent order: platform offered event-based binary options as swaps without registration; wind-down and civil penalty.",
      sources: ["Sample CFTC order", "Sample press release"] },

    { id: "m3", caption: "Nevada Gaming Control Bd. v. Kalshi", platform: "Kalshi",
      parties: [{ name: "Nevada GCB", role: "Regulator" }, { name: "KalshiEX LLC", role: "Respondent" }],
      contractType: "Sports", forum: "State gaming regulator", states: ["NV"],
      statutes: ["Nev. Rev. Stat. §463"], gate: "special",
      doctrinalQuestion: 'Are sports-outcome contracts unlicensed "gambling" under state law, or preempted swaps?',
      posture: "Pending", outcome: "Pending", filedDate: "2025-03-12", decidedDate: null,
      summary: "Cease-and-desist asserting state gaming jurisdiction over sports event contracts; exchange claims CEA preemption. Injunction briefing pending.",
      sources: ["Sample C&D letter"] },

    { id: "m4", caption: "N.J. Div. of Gaming Enforcement v. Kalshi", platform: "Kalshi",
      parties: [{ name: "NJ DGE", role: "Regulator" }, { name: "KalshiEX LLC", role: "Respondent" }],
      contractType: "Sports", forum: "State gaming regulator", states: ["NJ"],
      statutes: ["N.J.S.A. 5:12A"], gate: "special",
      doctrinalQuestion: "Does federal exchange registration preempt state sports-wagering law?",
      posture: "Pending", outcome: "Pending", filedDate: "2025-04-02", decidedDate: null,
      summary: "State demands the exchange halt sports contracts for in-state users; exchange obtains temporary relief pending preemption ruling.",
      sources: ["Sample C&D letter", "Sample TRO"] },

    { id: "m5", caption: "Maryland Lottery & Gaming v. Kalshi", platform: "Kalshi",
      parties: [{ name: "MD Lottery & Gaming", role: "Regulator" }, { name: "KalshiEX LLC", role: "Respondent" }],
      contractType: "Sports", forum: "State gaming regulator", states: ["MD"],
      statutes: ["Md. Code, State Gov’t §9"], gate: "special",
      doctrinalQuestion: 'Are event contracts "sports wagering" requiring a state license?',
      posture: "Enjoined", outcome: "Enjoined", filedDate: "2025-04-18", decidedDate: "2025-05-30",
      summary: "State board orders suspension of sports contracts; preliminary injunction granted against in-state offering pending federal resolution.",
      sources: ["Sample board order"] },

    { id: "m6", caption: "Forecast Foundation Enforcement (SEC Inquiry)", platform: "Polymarket",
      parties: [{ name: "SEC", role: "Regulator" }, { name: "Forecast Foundation", role: "Subject" }],
      contractType: "Cultural", forum: "SEC", states: ["NY"],
      statutes: ["Securities Act §2(a)(1)", "Howey"], gate: "howey",
      doctrinalQuestion: "Do tokenized outcome shares constitute investment-contract securities?",
      posture: "Pending", outcome: "Pending", filedDate: "2024-09-10", decidedDate: null,
      summary: "Wells-notice stage inquiry into whether cultural-event share tokens are securities under Howey; no charges filed.",
      sources: ["Sample inquiry notice"] },

    { id: "m7", caption: "Ohio ex rel. v. PredictIt Operator", platform: "PredictIt",
      parties: [{ name: "Ohio AG", role: "Plaintiff" }, { name: "Aristotle Intl.", role: "Defendant" }],
      contractType: "Election", forum: "State court", states: ["OH"],
      statutes: ["Ohio Rev. Code §2915"], gate: "special",
      doctrinalQuestion: 'Is an academic no-action market an illegal "scheme of chance"?',
      posture: "Dismissed", outcome: "Dismissed", filedDate: "2023-06-20", decidedDate: "2024-02-14",
      summary: "State gambling claim dismissed; court found the no-action-relief research market fell outside the chance-scheme statute.",
      sources: ["Sample dismissal order"] },

    { id: "m8", caption: "Kalshi v. Arizona Dep’t of Gaming", platform: "Kalshi",
      parties: [{ name: "KalshiEX LLC", role: "Plaintiff" }, { name: "AZ Dep’t of Gaming", role: "Defendant" }],
      contractType: "Sports", forum: "Federal court", states: ["AZ"],
      statutes: ["CEA §2(a)(1)", "Supremacy Clause"], gate: "special",
      doctrinalQuestion: "Does the CEA field-preempt state regulation of listed sports contracts?",
      posture: "Permitted", outcome: "Permitted", filedDate: "2025-04-25", decidedDate: "2025-06-09",
      summary: "Declaratory action; federal court enjoins state enforcement, finding likely CEA preemption of the contracts at issue.",
      sources: ["Sample preemption order"] },

    { id: "m9", caption: "CFTC v. Polymarket (Sports Listings)", platform: "Polymarket",
      parties: [{ name: "CFTC", role: "Regulator" }, { name: "Polymarket DAO", role: "Respondent" }],
      contractType: "Sports", forum: "CFTC", states: [],
      statutes: ["CEA §5c(c)(5)(C)"], gate: "swap",
      doctrinalQuestion: "May an unregistered venue list sports event contracts to U.S. persons?",
      posture: "Regulator action", outcome: "Pending", filedDate: "2025-02-01", decidedDate: null,
      summary: "Enforcement review into renewed U.S.-facing sports markets after the prior settlement; review pending.",
      sources: ["Sample review notice"] },

    { id: "m10", caption: "Illinois Gaming Bd. v. Kalshi", platform: "Kalshi",
      parties: [{ name: "IL Gaming Board", role: "Regulator" }, { name: "KalshiEX LLC", role: "Respondent" }],
      contractType: "Sports", forum: "State gaming regulator", states: ["IL"],
      statutes: ["230 ILCS 45"], gate: "special",
      doctrinalQuestion: 'Are sports contracts "wagers" subject to the state Sports Wagering Act?',
      posture: "Pending", outcome: "Pending", filedDate: "2025-04-08", decidedDate: null,
      summary: "State demand letter; exchange seeks federal declaratory relief. Consolidated preemption question pending.",
      sources: ["Sample demand letter"] },

    { id: "m11", caption: "Smith v. Kalshi (Economic Index Contracts)", platform: "Kalshi",
      parties: [{ name: "Retail claimants", role: "Plaintiffs" }, { name: "KalshiEX LLC", role: "Defendant" }],
      contractType: "Economic indicator", forum: "Federal court", states: ["TX"],
      statutes: ["CEA private right §22", "State UDAP"], gate: "cleared",
      doctrinalQuestion: "Do CPI/rate-print contracts mislead retail traders as to risk?",
      posture: "Settled", outcome: "Settled", filedDate: "2024-08-15", decidedDate: "2025-01-20",
      summary: "Putative class over economic-indicator contract disclosures; resolved via classwide settlement and disclosure reforms.",
      sources: ["Sample settlement agreement"] },

    { id: "m12", caption: "California DOJ v. Offshore Cultural Markets", platform: "Other",
      parties: [{ name: "CA DOJ", role: "Plaintiff" }, { name: "Doe operator", role: "Defendant" }],
      contractType: "Cultural", forum: "State court", states: ["CA"],
      statutes: ["Cal. Penal Code §330", "Cal. Bus. & Prof. §17200"], gate: "special",
      doctrinalQuestion: "Are offshore award-show contracts unlawful gambling and unfair competition?",
      posture: "Enjoined", outcome: "Enjoined", filedDate: "2024-03-04", decidedDate: "2024-11-12",
      summary: "State enjoins an unlicensed offshore operator marketing cultural-event contracts to California residents.",
      sources: ["Sample injunction"] },

  ];
})(typeof window !== "undefined" ? window : this);
