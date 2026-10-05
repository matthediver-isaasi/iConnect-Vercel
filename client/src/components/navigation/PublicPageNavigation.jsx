import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { publicClient } from '@/api/publicClient';
import { readPublicPage, DYNAMIC_PAGE_PENDING_TIMEOUT_MS } from '@/pages/dynamicPageRequest';
import { isRelevantAccountStorageTransition } from '@/pages/dynamicPageFirstLoad';

const PublicPageNavigationContext = createContext(null);

// This is a one-navigation request handoff, NOT a page/permission cache.
// No result survives consumption, a route change, or an audience epoch.
export function createPublicPageHandoff() {
  let entry = null;
  return {
    clear() { entry = null; },
    put(scope, request, promise, result) { entry = { scope, request, promise, result }; },
    take(scope, request) {
      if (!entry || entry.scope !== scope
        || entry.request.slug !== request?.slug
        || entry.request.micrositePrefix !== request?.micrositePrefix) return null;
      const handoff = { promise: entry.promise, result: entry.result };
      entry = null;
      return handoff;
    },
  };
}

export function eligiblePublicPageLink(anchor, event, currentUrl, resolveDestination) {
  if (!anchor || event.defaultPrevented || event.button !== 0
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    || anchor.hasAttribute('download')
    || (anchor.target && anchor.target !== '_self')
    || anchor.rel?.split(/\s+/).includes('external')) return null;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return null;
  let url;
  try { url = new URL(href, currentUrl); } catch { return null; }
  if (url.origin !== currentUrl.origin || !['http:', 'https:'].includes(url.protocol)
    || url.search || url.pathname === currentUrl.pathname) return null;
  const request = resolveDestination(url.pathname);
  return request ? { request, to: url.pathname + url.hash } : null;
}

export function PublicPageNavigationProvider({ children, scope, enabled, resolveDestination }) {
  const navigate = useNavigate();
  const location = useLocation();
  const handoff = useRef(createPublicPageHandoff());
  const epoch = useRef({ scope, enabled, path: location.key, sequence: 0 });
  const activeRequests = useRef(0);
  const blockedScope = useRef(null);
  const [pending, setPending] = useState(null);
  if (epoch.current.scope !== scope) blockedScope.current = null;
  if (epoch.current.scope !== scope || epoch.current.enabled !== enabled
    || epoch.current.path !== location.key) {
    epoch.current = { scope, enabled, path: location.key, sequence: epoch.current.sequence + 1 };
    // Keep the handoff for the just-requested destination only.
    if (pending?.to !== location.pathname + location.hash || !enabled || pending?.scope !== scope) {
      handoff.current.clear();
    }
    if (pending) setPending(null);
  }
  useEffect(() => {
    const onStorage = event => {
      if (!isRelevantAccountStorageTransition(event)) return;
      epoch.current.sequence += 1;
      blockedScope.current = epoch.current.scope;
      handoff.current.clear();
      setPending(null);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => () => {
    epoch.current.sequence += 1;
    handoff.current.clear();
  }, []);

  const cancel = () => {
    epoch.current.sequence += 1;
    handoff.current.clear();
    setPending(null);
  };
  const onClick = event => {
    if (!enabled || blockedScope.current === scope) return;
    const anchor = event.target?.closest?.('a[href]');
    const destination = eligiblePublicPageLink(anchor, event, new URL(window.location.href), resolveDestination);
    if (!destination) return;
    // At most two outstanding transports, even under rapid repeated clicks.
    if (activeRequests.current >= 2) {
      cancel();
      event.preventDefault();
      navigate(destination.to);
      return;
    }
    event.preventDefault();
    const sequence = ++epoch.current.sequence;
    const path = location.key;
    handoff.current.clear();
    setPending({ to: destination.to, scope });
    activeRequests.current += 1;
    const promise = readPublicPage(() => publicClient.getPage(
      destination.request.slug, destination.request.micrositePrefix,
    ));
    // A rejected request is handed to DynamicPage's existing error state.
    // Attaching both handlers also prevents an unhandled prefetch rejection.
    let result;
    const settled = promise.then(value => { result = value; }, () => {}).finally(() => { activeRequests.current -= 1; });
    let timer;
    Promise.race([settled, new Promise(resolve => {
      timer = setTimeout(resolve, DYNAMIC_PAGE_PENDING_TIMEOUT_MS);
    })]).then(() => {
      clearTimeout(timer);
      if (epoch.current.sequence !== sequence || epoch.current.scope !== scope
        || !epoch.current.enabled || epoch.current.path !== path) return;
      handoff.current.put(scope, destination.request, promise, result);
      navigate(destination.to);
    });
  };
  const visiblePending = pending && pending.scope === scope && enabled
    && pending.to !== location.pathname + location.hash;
  return (
    <PublicPageNavigationContext.Provider value={{
      onClick,
      take: request => enabled && blockedScope.current !== scope ? handoff.current.take(scope, request) : null,
      pending: visiblePending,
      cancel,
    }}>
      {children}
    </PublicPageNavigationContext.Provider>
  );
}

export function usePublicPageNavigation() {
  return useContext(PublicPageNavigationContext);
}

export function PublicNavigationPending() {
  const navigation = usePublicPageNavigation();
  if (!navigation?.pending) return null;
  return (
    <div className="sticky top-0 z-50 flex items-center justify-center gap-4 border-b bg-background px-4 py-2 text-sm text-foreground">
      <span role="status" aria-live="polite">Loading page…</span>
      <button type="button" className="underline underline-offset-4" onClick={navigation.cancel}>Cancel</button>
    </div>
  );
}
