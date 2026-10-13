export const FAVICON_PATHS = ['/favicon.ico', '/favicon.png', '/favicon-32.png', '/favicon-192.png', '/favicon-512.png', '/apple-touch-icon.png'];
export function faviconSize(path) {
  const pathname = String(path || '').split('?')[0];
  if (pathname === '/favicon-32.png') return 32;
  if (pathname === '/favicon-512.png') return 512;
  if (pathname === '/apple-touch-icon.png') return 180;
  return 192;
}
export const FAVICON_LINKS = '<link rel="icon" id="dynamic-favicon" type="image/png" sizes="192x192" href="/favicon-192.png"><link rel="apple-touch-icon" type="image/png" sizes="180x180" href="/apple-touch-icon.png">';

export function safeFaviconUrl(value) {
  if (typeof value !== 'string' || /[\\\s<>"]/.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//') &&
    !/^\/favicon\.ico(?:[?#]|$)/i.test(value)) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}
