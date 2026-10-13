import { FAVICON_PATHS } from './shared/tenantFavicon.js';

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
    '/',
    '/favicon.ico',
    '/favicon.png',
    '/favicon-32.png',
    '/favicon-192.png',
    '/favicon-512.png',
    '/apple-touch-icon.png',
    '/site.webmanifest',
    '/((?!api/|_next/|_vercel/|sitemap\\.xml|robots\\.txt|favicon\\.ico|.*\\..*).*)',
  ],
};

export default async function middleware(request) {
  const userAgent = request.headers.get('user-agent') || '';
  const ua = userAgent.toLowerCase();

  const isCrawler = CRAWLER_USER_AGENTS.some(bot => ua.includes(bot));
  const requestUrl = new URL(request.url);
  const isRoot = requestUrl.pathname === '/';
  const isFavicon = FAVICON_PATHS.includes(requestUrl.pathname);
  const isManifest = requestUrl.pathname === '/site.webmanifest';
  if (!isCrawler && !isRoot && !isFavicon && !isManifest) {
    return;
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  const fullPath = pathname + url.search;
  const prerenderUrl = new URL(isManifest ? '/api/public/manifest' : isFavicon ? '/api/public/favicon' :
    (!isCrawler ? '/api/render' : '/api/public/prerender'), request.url);
  prerenderUrl.searchParams.set('path', fullPath);

  try {
    const response = await fetch(prerenderUrl.toString(), {
      method: request.method,
      redirect: 'manual',
      headers: {
        'host': request.headers.get('host') || '',
        'x-forwarded-host': request.headers.get('x-forwarded-host') || request.headers.get('host') || '',
        'x-forwarded-proto': 'https',
        'user-agent': userAgent,
        'x-original-uri': fullPath,
      },
    });

    const status = response.status;
    if (isFavicon || isManifest || status === 200 || status === 410 || status === 404 || status >= 500) {
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status,
        headers: {
          'content-type': response.headers.get('content-type') || 'text/html',
          'cache-control': response.headers.get('cache-control') || 'public, max-age=300',
          'x-prerendered': 'true',
          'vary': 'Host, X-Forwarded-Host',
          ...(response.headers.has('content-length') ? { 'content-length': response.headers.get('content-length') } : {}),
          ...(response.headers.has('allow') ? { allow: response.headers.get('allow') } : {}),
          ...(response.headers.has('location') ? { location: response.headers.get('location') } : {}),
          ...(isFavicon ? { 'x-content-type-options': 'nosniff' } : {}),
        },
      });
    }

    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (location) {
        return new Response(null, {
          status,
           headers: { 'location': location, 'cache-control': 'private, no-store' },
        });
      }
    }
  } catch (err) {
    console.error('[Middleware] Prerender fetch error:', err);
  }

  if (isFavicon || isManifest) return new Response(null, { status: 503, headers: { 'cache-control': 'private, no-store' } });
  return;
}
