import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Ask the server rather than comparing branding strings: microsites and
// registered routes must retain ownership of their URLs.
export function useHomepageCanonical() {
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    if (pathname === '/' || !/^\/[^/]+\/?$/.test(pathname) ||
      new URLSearchParams(search).has('_canvasPreview')) return;
    const controller = new AbortController();
    fetch(`/api/public/homepage-route?path=${encodeURIComponent(pathname + search + hash)}`,
      { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(result => {
        if (!controller.signal.aborted && result?.target?.startsWith('/') &&
          !result.target.startsWith('//')) window.location.replace(result.target);
      }).catch(() => {});
    return () => controller.abort();
  }, [pathname, search, hash]);
}
