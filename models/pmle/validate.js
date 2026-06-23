/* ============================================================================
 *  PREDICTION MARKET LITIGATION EXPLORER  ·  VALIDATE  (dev safety net)
 *  ---------------------------------------------------------------------------
 *  Runs once at load. For every matter it checks: required fields present,
 *  enum values legal, dates well-formed ISO (YYYY-MM-DD), and every state
 *  code present in TILES (otherwise it would silently vanish from the map).
 *
 *  Problems are reported as a single grouped console.warn naming each
 *  offending `id` and exactly what is wrong. It NEVER throws and never blocks
 *  rendering: bad data degrades gracefully, you just get a clear warning.
 *
 *  Returns an array of problem strings (also stashed on PMLE.dataProblems).
 * ========================================================================== */
(function (root) {
  "use strict";
  const PMLE = (root.PMLE = root.PMLE || {});

  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const REQUIRED = [
    "id", "caption", "platform", "parties", "contractType", "forum",
    "states", "statutes", "gate", "doctrinalQuestion", "posture",
    "outcome", "filedDate", "summary", "sources",
  ];

  function isValidISO(s) {
    if (!ISO.test(s)) return false;
    const d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && s === d.toISOString().slice(0, 10);
  }

  PMLE.validate = function validate(matters, constants) {
    const problems = [];
    const C = constants || (PMLE.constants || {});
    const E = C.ENUMS || {};
    const TILES = C.TILES || {};
    const seenIds = new Set();

    (matters || []).forEach((m, i) => {
      const id = m && m.id ? m.id : "(record #" + i + ", no id)";
      const flag = (msg) => problems.push(id + ": " + msg);

      if (!m || typeof m !== "object") { flag("is not an object"); return; }

      REQUIRED.forEach((f) => {
        if (m[f] === undefined || m[f] === null) {
          if (!(f === "decidedDate")) flag("missing required field `" + f + "`");
        }
      });

      if (m.id) {
        if (seenIds.has(m.id)) flag("duplicate id");
        seenIds.add(m.id);
      }

      const enumCheck = (field) => {
        if (m[field] !== undefined && E[field] && !E[field].includes(m[field]))
          flag("`" + field + "` = " + JSON.stringify(m[field]) + " is not one of [" + E[field].join(", ") + "]");
      };
      ["platform", "contractType", "forum", "outcome", "posture", "gate"].forEach(enumCheck);

      if (Array.isArray(m.parties)) {
        m.parties.forEach((p, j) => {
          if (!p || !p.name || !p.role) flag("parties[" + j + "] needs both `name` and `role`");
        });
      } else if (m.parties !== undefined) flag("`parties` must be an array");

      if (!Array.isArray(m.statutes)) flag("`statutes` must be an array");
      if (!Array.isArray(m.sources)) flag("`sources` must be an array");

      if (Array.isArray(m.states)) {
        m.states.forEach((st) => {
          if (!TILES[st]) flag("state `" + st + "` is not in TILES (it will not show on the map) - add it to constants.js");
        });
      } else if (m.states !== undefined) flag("`states` must be an array (use [] for none)");

      if (m.filedDate !== undefined && !isValidISO(m.filedDate))
        flag("`filedDate` = " + JSON.stringify(m.filedDate) + " is not ISO YYYY-MM-DD");
      if (m.decidedDate !== undefined && m.decidedDate !== null && !isValidISO(m.decidedDate))
        flag("`decidedDate` = " + JSON.stringify(m.decidedDate) + " must be null or ISO YYYY-MM-DD");
      if (isValidISO(m.filedDate) && isValidISO(m.decidedDate) && m.decidedDate < m.filedDate)
        flag("`decidedDate` is before `filedDate`");
    });

    PMLE.dataProblems = problems;
    if (problems.length && typeof console !== "undefined") {
      console.warn(
        "%cPMLE data validation: " + problems.length + " issue(s) found",
        "color:#FBBF24;font-weight:600"
      );
      problems.forEach((p) => console.warn("  • " + p));
    }
    return problems;
  };

  /* Auto-run when loaded in a browser after data + constants are present. */
  if (PMLE.matters && PMLE.constants) PMLE.validate(PMLE.matters, PMLE.constants);
})(typeof window !== "undefined" ? window : this);
