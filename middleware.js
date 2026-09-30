const CRAWLER_USER_AGENTS = [
  'googlebot',
  'google-inspectiontool',
  'google-structured-data-testing-tool',
  'storebot-google',
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

  const fullPath = pathname + url.search;
  const prerenderUrl = new URL('/api/public/prerender', request.url);
  prerenderUrl.searchParams.set('path', fullPath);

  try {
    const response = await fetch(prerenderUrl.toString(), {
      redirect: 'manual',
      headers: {
        'host': request.headers.get('host') || '',
        'x-forwarded-host': request.headers.get('x-forwarded-host') || request.headers.get('host') || '',
        'x-forwarded-proto': 'https',
        'user-agent': userAgent,
      },
    });

    const status = response.status;
    if (status === 200 || status === 410) {
      return new Response(response.body, {
        status,
        headers: {
          'content-type': response.headers.get('content-type') || 'text/html',
          'cache-control': response.headers.get('cache-control') || 'public, max-age=300',
          'x-prerendered': 'true',
        },
      });
    }

    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (location) {
        return new Response(null, {
          status,
          headers: { 'location': location },
        });
      }
    }
  } catch (err) {
    console.error('[Middleware] Prerender fetch error:', err);
  }

  return;
}
