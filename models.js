// ============================================================
//  INTERACTIVE MODELS: Edit this file to add new models.
//
//  Each model is an interactive demonstration of how something
//  in the law / finance / technology space works (e.g. the
//  securities analysis, insider-trading timelines, market
//  mechanics).
//
//  Models are grouped on the page by "category", so related
//  models appear together under their own section heading.
//
//  ── HOW TO ADD A NEW MODEL ──────────────────────────────────
//  Copy one of the blocks below, paste it at the TOP of the
//  array (right after the opening "["), and fill it in.
//
//  Required fields:
//    id        unique slug used in the URL  (/model/<id>)
//    category  section the model is grouped under
//    title     name shown on the card and model page
//    summary   one or two sentences shown on the card
//    status    "live"  → opens the interactive model
//              "soon"  → shows a "Coming soon" card (no link)
//
//  Provide the interactive content in ONE of two ways:
//    src   →  a path to a standalone .html file in the repo
//             (e.g. "/models/securities-analyzer.html"). Loaded
//             in a sandboxed iframe. Best for larger models:
//             write a normal standalone page, no escaping.
//    html  →  a full, self-contained HTML document as a string,
//             rendered inline in the sandboxed iframe. Handy for
//             small models you paste in directly.
//
//  (If both are given, "src" wins. "soon" models need neither.)
// ============================================================

const MODELS = [

  // ── COMING-SOON EXAMPLE ──────────────────────────────────
  // This is the pattern for a model you plan to build later.
  // Flip status to "live" and add `src` or `html` when ready.
  {
    id: "insider-trading-timeline",
    category: "Market Integrity",
    title: "Insider Trading: Anatomy of a Case",
    summary: "An interactive timeline that walks through a classic insider-trading fact pattern: who knew what, when, and how the elements of liability come together.",
    status: "soon",
  },

  // ── LIVE INTERACTIVE MODEL ───────────────────────────────
  // A full guided analyzer for whether an instrument is a
  // security: § 2(a)(1) threshold, Landreth (stock), Reves
  // (notes/debt), the three Howey prongs (with the common-
  // enterprise circuit split), entity & real-estate structures,
  // securitization, and the two Howey exceptions. Each option
  // carries its controlling doctrine and case law.
  {
    id: "securities-analyzer",
    category: "Securities Analysis",
    title: "Is It a Security? The Complete Analyzer",
    summary: "A guided, authority-backed walkthrough of the full federal securities analysis. Classify the instrument, toggle every operative fact, and watch each choice drive the determination with the controlling case law at every step.",
    status: "live",
    src: "/models/securities-analyzer.html",
  },

];
