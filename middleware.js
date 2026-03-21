// Vercel Edge Middleware
// Runs server-side before every request — rewrites og:url and canonical
// meta tags so LinkedIn's scraper sees the correct URL for each article.
// Works automatically for all current and future articles/insights.

export const config = {
  matcher: ['/article/:path*', '/insight/:path*', '/writings', '/'],
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const fullUrl = url.origin + url.pathname;

  // Fetch the original index.html
  const response = await fetch(new URL('/index.html', url.origin));
  let html = await response.text();

  // Replace og:url with the actual current URL
  html = html.replace(
    /<meta property="og:url" content="[^"]*"/,
    `<meta property="og:url" content="${fullUrl}"`
  );

  // Replace canonical link with the actual current URL
  html = html.replace(
    /<link id="canonical-url" rel="canonical" href="[^"]*"/,
    `<link id="canonical-url" rel="canonical" href="${fullUrl}"`
  );

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  });
}
