/* ============================================================================
 *  /api/surveillance/signals  —  the documented read API (§5)
 *  ---------------------------------------------------------------------------
 *    GET /api/surveillance/signals?mode=&platform=&category=&limit=
 *
 *  This is the stable, named contract the spec calls for. It delegates to the
 *  live feed handler (which enumerates both platforms, deep-enriches a bounded
 *  rotating batch, and fuses the requested engine), so `signals` and `feed`
 *  return the same payload shape — `signals` is just the canonical public name.
 *
 *    mode      = insider | manipulation   (default insider)
 *    platform  = kalshi | polymarket      (optional filter)
 *    category  = Politics | World | …      (optional filter)
 *    limit     = 20…200                    (default 120)
 * ========================================================================== */
"use strict";
module.exports = require("./feed.js");
