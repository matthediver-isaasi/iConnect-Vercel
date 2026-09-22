import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';

export const RouteLayoutContext = createContext(null);

/**
 * A decision is a lease for ONE route/audience, not a global preference.
 * Invalidate in render (before descendants can mount), never in an effect.
 * Tokens are objects so returning to an earlier URL cannot revive its lease.
 */
export function RouteLayoutProvider({ children, scope, pageOwned, prerequisitesReady = true }) {
  // Readiness can close temporarily while branding/auth metadata is refreshed.
  // Preserve the resolved shell kind across that temporary epoch, but require
  // the page to recommit its current decision before chrome becomes ready.
  // This avoids both parent-shell swaps and a frame of stale chrome when the
  // decision changed while prerequisites were unavailable.
  const scopeToken = useMemo(() => ({}), [scope, pageOwned]);
  const token = useMemo(() => ({}), [scopeToken, prerequisitesReady]);
  // Non-sensitive, confirmed public misses may survive the one shell remount
  // when a dynamic page resolves from public discovery to member chrome.
  // Route, tenant, audience and readiness epochs each discard this evidence.
  const publicPageMisses = useMemo(() => new Set(), [token]);
  const [record, setRecord] = useState(() => ({ token, scopeToken, decision: null }));
  const [overrides, setOverrides] = useState(() => ({ token }));
  if (record.token !== token) {
    // React retries this provider before committing its descendants.
    setRecord({
      token,
      scopeToken,
      decision: null,
      layoutDecision: record.scopeToken === scopeToken ? record.layoutDecision : null,
    });
    setOverrides({ token });
  }
  const commit = useCallback((decision) => {
    setRecord(current => current.token === token ? {
      token, scopeToken, decision,
      // Readiness may close while the same page refetches. Keep its resolved
      // shell kind so swapping public/portal parents cannot trigger a
      // remount -> refetch -> unresolved -> remount loop.
      layoutDecision: decision || current.layoutDecision,
    } : current);
  }, [token, scopeToken]);
  const setForceBlankLayout = useCallback((value) => {
    setOverrides(previous => previous.token === token
      ? { ...previous, forceBlankLayout: value }
      : previous);
  }, [token]);
  const setForcePublicLayout = useCallback((value) => {
    setOverrides(previous => previous.token === token
      ? { ...previous, forcePublicLayout: value }
      : previous);
  }, [token]);

  const decision = record?.token === token ? record.decision : null;
  const layoutDecision = record?.token === token ? record.layoutDecision : null;
  const ready = !pageOwned || (prerequisitesReady && !!decision);
  const local = overrides?.token === token ? overrides : {};
  const blank = local.forceBlankLayout ?? decision?.forceBlankLayout ?? layoutDecision?.forceBlankLayout ?? false;
  const value = {
    publicPageMisses,
    commit,
    pageOwned,
    chromeReady: ready,
    publicChrome: ready && !blank ? (decision?.publicChrome || 'both') : 'none',
    // Until the decision arrives keep page components in the public shell.
    forcePublicLayout: local.forcePublicLayout ?? (pageOwned
      ? (blank || !layoutDecision || !!layoutDecision.forcePublicLayout)
      : false),
    forceBlankLayout: blank,
    setForceBlankLayout,
    setForcePublicLayout,
  };
  return <RouteLayoutContext.Provider value={value}>{children}</RouteLayoutContext.Provider>;
}

export function usePageLayoutDecision(decision) {
  const context = useContext(RouteLayoutContext);
  const commit = context?.commit;
  const ready = !!decision;
  const publicChrome = decision?.publicChrome || 'both';
  const forcePublicLayout = !!decision?.forcePublicLayout;
  const forceBlankLayout = !!decision?.forceBlankLayout;
  useLayoutEffect(() => {
    commit?.(ready ? { publicChrome, forcePublicLayout, forceBlankLayout } : null);
    // No cleanup: a previous page must never reset the next page to "both".
  }, [commit, ready, publicChrome, forcePublicLayout, forceBlankLayout]);
}