/* ============================================================================
 *  PREDICTION MARKET LITIGATION EXPLORER  ·  CONSTANTS  (single source of truth)
 *  ---------------------------------------------------------------------------
 *  Everything the UI keys off of lives here: the controlled vocabularies
 *  (enums), the color / letter maps for posture & outcome, the forum and
 *  contract-type lists, the doctrine gates, and the US tile-grid layout.
 *
 *  Adding a new category or state is a ONE-LINE change in this file:
 *    - new outcome / posture  -> add to OUT / POSTURE (color + single letter)
 *    - new forum / contract   -> add to FORUMS / CTYPES
 *    - new platform           -> add to PLATFORMS
 *    - new state on the map   -> add to TILES with its [row, col]
 *
 *  The data file (data.js) and the validator (validate.js) both read from
 *  these lists, so the UI, the filters, and the validation stay in lock-step.
 *
 *  Exposed as the global `PMLE.constants` (and a few top-level helpers).
 * ========================================================================== */
(function (root) {
  "use strict";
  const PMLE = (root.PMLE = root.PMLE || {});

  /* -- OUTCOME: how the matter resolved -----------------------------------
   * c = color, g = soft glow background, l = single-letter glyph (so we
   * never rely on color alone), label = human text. */
  const OUT = {
    Pending:   { c: "#FBBF24", g: "rgba(251,191,36,.16)",  l: "P", label: "Pending" },
    Enjoined:  { c: "#F87171", g: "rgba(248,113,113,.16)", l: "E", label: "Enjoined" },
    Permitted: { c: "#34D399", g: "rgba(52,211,153,.16)",  l: "A", label: "Permitted" },
    Settled:   { c: "#60A5FA", g: "rgba(96,165,250,.16)",  l: "S", label: "Settled" },
    Dismissed: { c: "#9CA3AF", g: "rgba(156,163,175,.14)", l: "D", label: "Dismissed" },
  };

  /* -- POSTURE: the matter's current procedural stance --------------------
   * Used to color the map (one posture per state, by priority below). */
  const POSTURE = {
    Enjoined:           { c: "#F87171", l: "E", label: "Enjoined" },
    "Regulator action": { c: "#FB923C", l: "R", label: "Regulator action" },
    Pending:            { c: "#FBBF24", l: "P", label: "Litigation pending" },
    Permitted:          { c: "#34D399", l: "A", label: "Permitted" },
    Settled:            { c: "#60A5FA", l: "S", label: "Settled" },
    Dismissed:          { c: "#6B7280", l: "D", label: "Dismissed" },
  };

  /* When a state has several matters with different postures, the map shows
   * the most "active" one. Earlier in this list wins. */
  const POST_PRIORITY = ["Enjoined", "Regulator action", "Pending", "Settled", "Dismissed", "Permitted"];

  /* -- Controlled vocabularies (filter options + validation enums) -------- */
  const PLATFORMS = ["Kalshi", "Polymarket", "PredictIt", "Other"];
  const CTYPES    = ["Election", "Sports", "Economic indicator", "Cultural", "Other"];
  const FORUMS    = ["CFTC", "SEC", "State gaming regulator", "Federal court", "State court"];

  /* -- DOCTRINE FLOW gates ------------------------------------------------
   * `gate` on each matter says which classification question it actually
   * turned on. GATE_ORDER drives the left-to-right flow; STATIONS are the
   * labeled columns drawn in the Doctrine lens (\n = line break in the SVG). */
  const GATE_ORDER = ["swap", "special", "howey", "cleared"];
  const GATE_LABELS = {
    swap:    "Is it a swap? (CEA / CFTC jurisdiction)",
    special: "Special rule on enumerated / gaming activity",
    howey:   "Is it a security under Howey?",
    cleared: "Cleared / permitted to list",
  };
  const DOCTRINE_STATIONS = [
    ["entry",   "Contracts"],
    ["swap",    "Is it a swap?"],
    ["special", "Special rule\n(gaming / enumerated)?"],
    ["howey",   "Security\nunder Howey?"],
    ["cleared", "Cleared /\nPermitted"],
  ];

  /* -- US TILE GRID -------------------------------------------------------
   * state USPS code -> [row, col] in the cartogram. Add a state here to make
   * it appear on the map; data.js / validate.js reject states not listed. */
  const TILES = {
    //          col0  col1  col2  col3  col4  col5  col6  col7  col8  col9  col10
    /* row0 */  AK: [0, 0],                                                                                    ME: [0, 10],
    /* row1 */                                                                            VT: [1, 9],          NH: [1, 10],
    /* row2 */  WA: [2, 0], ID: [2, 1], MT: [2, 2], ND: [2, 3], MN: [2, 4], WI: [2, 5], MI: [2, 6],            NY: [2, 8], RI: [2, 9], MA: [2, 10],
    /* row3 */  OR: [3, 0], NV: [3, 1], WY: [3, 2], SD: [3, 3], IA: [3, 4], IL: [3, 5], IN: [3, 6], OH: [3, 7], PA: [3, 8], NJ: [3, 9], CT: [3, 10],
    /* row4 */  CA: [4, 0], UT: [4, 1], CO: [4, 2], NE: [4, 3], MO: [4, 4], KY: [4, 5], WV: [4, 6], VA: [4, 7], MD: [4, 8], DE: [4, 9],
    /* row5 */              AZ: [5, 1], NM: [5, 2], KS: [5, 3], AR: [5, 4], TN: [5, 5], NC: [5, 6], SC: [5, 7], DC: [5, 8],
    /* row6 */                                      OK: [6, 3], LA: [6, 4], MS: [6, 5], AL: [6, 6], GA: [6, 7],
    /* row7 */  HI: [7, 0],                         TX: [7, 3],                                     FL: [7, 8],
  };

  /* Year window the timeline / scrubber / year-filter span. */
  const YEAR_MIN = 2014;
  const YEAR_MAX = 2026;

  /* Allowed enum values, derived from the maps above so they never drift. */
  const ENUMS = {
    platform:     PLATFORMS,
    contractType: CTYPES,
    forum:        FORUMS,
    outcome:      Object.keys(OUT),
    posture:      Object.keys(POSTURE),
    gate:         GATE_ORDER,
  };

  PMLE.constants = {
    OUT, POSTURE, POST_PRIORITY,
    PLATFORMS, CTYPES, FORUMS,
    GATE_ORDER, GATE_LABELS, DOCTRINE_STATIONS,
    TILES, YEAR_MIN, YEAR_MAX, ENUMS,
  };

  /* Small shared helper used across data + UI. */
  PMLE.yearOf = (s) => (s ? parseInt(String(s).slice(0, 4), 10) : null);
})(typeof window !== "undefined" ? window : this);
