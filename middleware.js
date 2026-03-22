// ============================================================
//  VERCEL EDGE MIDDLEWARE
//  Injects correct og:url, og:title, og:description, and
//  canonical tag server-side so LinkedIn previews show the
//  right title and description for each article.
//
//  IMPORTANT: When you add a new article to posts.js or
//  insights.js, also add it to the ARTICLES object below.
//  Just copy the format and add the id, title, and summary.
// ============================================================

// ─── ADD NEW ARTICLES HERE ───────────────────────────────────
// Key = the id field from your posts.js or insights.js entry
const ARTICLES = {

  // ── INSIGHTS ──
  'cftc-mlb-prediction-markets-2026': {
    title: 'CFTC-MLB Agreement Signals Next Step in Prediction Market Oversight',
    description: "The CFTC's first formal agreement with a professional sports league establishes a framework for cooperation on sports-related prediction markets.",
  },
  'sec-cftc-joint-interpretation-crypto': {
    title: 'Drawing a Clearer Line: SEC & CFTC Issue Joint Interpretive Guidance on the State of Crypto Assets',
    description: "The SEC and CFTC's March 17, 2026 joint interpretive guidance clarifies the application of federal securities laws to crypto assets, applying the Howey framework while introducing a functional taxonomy and addressing key activities such as staking, mining, and token separation.",
  },

  // ── PUBLICATIONS ──
  // Add new entries here when you publish, e.g.:
  // 'my-new-article-id': {
  //   title: 'Your Article Title Here',
  //   description: 'One or two sentence summary shown on LinkedIn.',
  // },

};
// ─────────────────────────────────────────────────────────────

const OG_IMAGE = 'https://www.michael-gertsik.com/LINKEDIN_IMAGE.png';

export const config = {
  matcher: ['/article/:path*', '/insight/:path*', '/writings', '/'],
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const fullUrl = url.origin + url.pathname;
  const path = url.pathname;

  const response = await fetch(new URL('/index.html', url.origin));
  let html = await response.text();

  let pageTitle = 'Michael Gertsik';
  let pageDesc = '2L · Fordham University School of Law';

  const match = path.match(/^\/(article|insight)\/(.+)$/);
  const id = match?.[2];

  if (id && ARTICLES[id]) {
    pageTitle = ARTICLES[id].title;
    pageDesc = ARTICLES[id].description;
  }

  html = html.replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${fullUrl}"`);
  html = html.replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${escapeHtml(pageTitle)}"`);
  html = html.replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${escapeHtml(pageDesc)}"`);
  html = html.replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${escapeHtml(pageDesc)}"`);
  html = html.replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${escapeHtml(pageTitle)}"`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${escapeHtml(pageDesc)}"`);
  html = html.replace(/<link id="canonical-url" rel="canonical" href="[^"]*"/, `<link id="canonical-url" rel="canonical" href="${fullUrl}"`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`);

  // Inject og:image — always your LINKEDIN_IMAGE.png
  if (!html.includes('og:image')) {
    html = html.replace(
      /<meta property="og:url"/,
      `<meta property="og:image" content="${OG_IMAGE}" />\n  <meta property="og:url"`
    );
  } else {
    html = html.replace(/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="${OG_IMAGE}"`);
  }

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
