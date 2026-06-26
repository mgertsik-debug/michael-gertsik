"use strict";
// LIVE SITE CHECK — runs in GitHub Actions (networked) to diagnose "the site shows
// stale content even on hard refresh". For each URL it reports the HTTP status, the
// cache-relevant headers (who/what is caching), and whether the freshly-shipped
// version markers are present in the served bytes. That pinpoints deploy-vs-CDN-vs-
// routing without guessing.
const SITE = process.env.SITE || "https://www.michael-gertsik.com";

const MARKERS = {
  "/models/insider-trading.html": ["wallet-forensics.html?v=14", "wallet-forensics.html?v="],
  "/models/wallet-forensics.html": ["THE NUMBERS, VISUALISED", "Download full record", "polygonscan.com/address", "writeClipboard"],
  "/": ["<title", "insider", "forensic"],
  "/api/forensics/subjects": ["subjects", "observed"],
};
const HEADERS = ["server", "cache-control", "age", "etag", "last-modified", "x-vercel-cache", "x-vercel-id", "cf-cache-status", "cf-ray", "via", "expires", "date"];

async function check(pathname) {
  const url = SITE + pathname;
  console.log("\n===== " + url + " =====");
  try {
    const r = await fetch(url, { redirect: "manual", headers: { "cache-control": "no-cache", "pragma": "no-cache" } });
    console.log("status: " + r.status + (r.headers.get("location") ? " → " + r.headers.get("location") : ""));
    for (const h of HEADERS) { const v = r.headers.get(h); if (v) console.log("  " + h + ": " + v); }
    const body = await r.text().catch(() => "");
    console.log("  bytes: " + body.length);
    const want = MARKERS[pathname] || [];
    for (const m of want) console.log("  marker " + (body.includes(m) ? "FOUND   " : "MISSING ") + JSON.stringify(m));
    // surface the actual ?v= the served outer page is pointing the iframe at
    const vm = body.match(/wallet-forensics\.html\?v=(\d+)/);
    if (vm) console.log("  >>> served iframe version: ?v=" + vm[1]);
  } catch (e) { console.log("  ERROR: " + (e && e.message)); }
}

(async () => {
  console.log("# site check against " + SITE + " at " + new Date().toISOString());
  for (const p of Object.keys(MARKERS)) await check(p);
  console.log("\n# done");
})();
