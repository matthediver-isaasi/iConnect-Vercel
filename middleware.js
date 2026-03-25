const CRAWLER_USER_AGENTS = [
  'googlebot',
  'bingbot',
  'slurp',
  'duckduckbot',
  'baiduspider',
  'yandexbot',
  'sogou',
  'facebookexternalhit',
  'twitterbot',
  'linkedinbot',
  'whatsapp',
  'telegrambot',
  'applebot',
  'petalbot',
  'semrushbot',
  'ahrefsbot',
  'mj12bot',
  'pinterest',
  'discordbot',
];

const PUBLIC_ROUTE_PATTERNS = [
  /^\/$/,
  /^\/Home$/,
  /^\/PublicEvents$/,
  /^\/PublicArticles$/,
  /^\/PublicNews$/,
  /^\/PublicResources$/,
  /^\/JobBoard$/,
  /^\/JobDetails/,
  /^\/OrganisationDirectory$/,
  /^\/events\/[^/]+/,
  /^\/articles\/[^/]+\/[^/]+/,
  /^\/NewsView/,
  /^\/ViewPage/,
  /^\/EventDetails/,
];

export const config = {
  matcher: [
    '/((?!api/|_next/|_vercel/|sitemap\\.xml|robots\\.txt|favicon\\.ico|.*\\..*).*)',
  ],
};

export default async function middleware(request) {
  const userAgent = request.headers.get('user-agent') || '';
  const ua = userAgent.toLowerCase();

  const isCrawler = CRAWLER_USER_AGENTS.some(bot => ua.includes(bot));
  if (!isCrawler) {
    return;
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  let isPublicRoute = PUBLIC_ROUTE_PATTERNS.some(pattern => pattern.test(pathname));

  if (!isPublicRoute) {
    const customArticleDetailPattern = /^\/[a-z][a-z0-9-]*\/[^/]+\/[^/]+$/;
    const customArticleListPattern = /^\/[a-z][a-z0-9-]+$/;
    if (customArticleDetailPattern.test(pathname) || customArticleListPattern.test(pathname)) {
      isPublicRoute = true;
    }
  }

  if (!isPublicRoute) {
    return;
  }

  const fullPath = pathname + url.search;
  const prerenderUrl = new URL('/api/public/prerender', request.url);
  prerenderUrl.searchParams.set('path', fullPath);

  try {
    const response = await fetch(prerenderUrl.toString(), {
      headers: {
        'host': request.headers.get('host') || '',
        'x-forwarded-host': request.headers.get('x-forwarded-host') || request.headers.get('host') || '',
        'x-forwarded-proto': 'https',
        'user-agent': userAgent,
      },
    });

    if (response.ok) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') || 'text/html',
          'cache-control': response.headers.get('cache-control') || 'public, max-age=300',
          'x-prerendered': 'true',
        },
      });
    }
  } catch (err) {
    console.error('[Middleware] Prerender fetch error:', err);
  }

  return;
}
