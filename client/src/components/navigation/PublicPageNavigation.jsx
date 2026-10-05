import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { publicClient } from '@/api/publicClient';
import { readPublicPage, DYNAMIC_PAGE_PENDING_TIMEOUT_MS } from '@/pages/dynamicPageRequest';
import { isRelevantAccountStorageTransition } from '@/pages/dynamicPageFirstLoad';
import { createPublicPageIntentPool, PUBLIC_PAGE_INTENT_DELAY_MS } from './publicPageIntent';

const PublicPageNavigationContext = createContext(null);

// This is a one-navigation request handoff, NOT a page/permission cache.
// No result survives consumption, an unrelated route, or an audience epoch.
export function createPublicPageHandoff() {
  let entry = null;
  return {
    clear() { entry = null; },
    put(scope, request, promise, result, to) { entry = { scope, request, promise, result, to }; },
    retain(scope, to) {
      if (entry?.scope !== scope || entry?.to !== to) entry = null;
    },
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
  const pool = useRef(null);
  if (!pool.current) pool.current = createPublicPageIntentPool((request, signal) =>
    readPublicPage(() => publicClient.getPage(request.slug, request.micrositePrefix, { signal })));
  const intentTimer = useRef(null);
  const activation = useRef(null);
  const blockedScope = useRef(null);
  const [pending, setPending] = useState(null);
  if (epoch.current.scope !== scope) blockedScope.current = null;
  if (epoch.current.scope !== scope || epoch.current.enabled !== enabled
    || epoch.current.path !== location.key) {
    clearTimeout(intentTimer.current);
    pool.current.clear();
    activation.current = null;
    epoch.current = { scope, enabled, path: location.key, sequence: epoch.current.sequence + 1 };
    // Microsite branding readiness may close at the destination. Preserve
    // its exact one-use transport, not any rendering/authorization decision.
    // Scope changes fence auth/tenant/role; DynamicPage still waits for *all*
    // destination prerequisites before consuming data or committing chrome.
    handoff.current.retain(scope, location.pathname + location.hash);
    if (pending) setPending(null);
  }
  useEffect(() => {
    const onStorage = event => {
      if (!isRelevantAccountStorageTransition(event)) return;
      epoch.current.sequence += 1;
      blockedScope.current = epoch.current.scope;
      handoff.current.clear();
      clearTimeout(intentTimer.current);
      pool.current.clear();
      activation.current = null;
      setPending(null);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => () => {
    epoch.current.sequence += 1;
    handoff.current.clear();
    clearTimeout(intentTimer.current);
    pool.current.clear();
  }, []);

  const cancel = () => {
    epoch.current.sequence += 1;
    handoff.current.clear();
    clearTimeout(intentTimer.current);
    pool.current.clear();
    activation.current = null;
    setPending(null);
  };
  const destinationFor = event => {
    if (!enabled || blockedScope.current === scope) return;
    const anchor = event.target?.closest?.('a[href]');
    return eligiblePublicPageLink(anchor, event, new URL(window.location.href), resolveDestination);
  };
  const onIntent = event => {
    if (activation.current || (event.pointerType && event.pointerType !== 'mouse')) return;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || (event.relatedTarget?.nodeType && anchor.contains(event.relatedTarget))) return;
    const destination = destinationFor({ ...event, target: anchor, button: 0 });
    if (!destination) return;
    clearTimeout(intentTimer.current);
    const currentEpoch = epoch.current;
    intentTimer.current = setTimeout(() => {
      if (epoch.current !== currentEpoch || activation.current) return;
      pool.current.acquire(scope, destination.request);
    }, PUBLIC_PAGE_INTENT_DELAY_MS);
  };
  const onIntentLeave = event => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || (event.relatedTarget?.nodeType && anchor.contains(event.relatedTarget))
      || anchor === document.activeElement || activation.current) return;
    clearTimeout(intentTimer.current);
    pool.current.clear();
  };
  const onClick = event => {
    const destination = destinationFor(event);
    if (!destination) return;
    event.preventDefault();
    clearTimeout(intentTimer.current);
    if (activation.current?.to === destination.to && activation.current.scope === scope) return;
    const task = pool.current.acquire(scope, destination.request, true);
    activation.current = { task, to: destination.to, scope };
    const sequence = ++epoch.current.sequence;
    const path = location.key;
    handoff.current.clear();
    setPending({ to: destination.to, scope });
    let timer;
    Promise.race([task.settled, new Promise(resolve => {
      timer = setTimeout(() => { task.controller.abort(); resolve(); }, DYNAMIC_PAGE_PENDING_TIMEOUT_MS);
    })]).then(() => {
      clearTimeout(timer);
      if (epoch.current.sequence !== sequence || epoch.current.scope !== scope
        || !epoch.current.enabled || epoch.current.path !== path) return;
      handoff.current.put(scope, destination.request, task.promise, task.result, destination.to);
      navigate(destination.to);
    });
  };
  const visiblePending = pending && pending.scope === scope && enabled
    && pending.to !== location.pathname + location.hash;
  return (
    <PublicPageNavigationContext.Provider value={{
      onClick,
      onIntent,
      onIntentLeave,
      take: request => blockedScope.current !== scope ? handoff.current.take(scope, request) : null,
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
    <span className="sr-only" role="status" aria-live="polite">Opening page</span>
  );
}
