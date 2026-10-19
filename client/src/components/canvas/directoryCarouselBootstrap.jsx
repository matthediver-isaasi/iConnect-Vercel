import { createContext, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { usePublicPageNavigation } from '@/components/navigation/PublicPageNavigation';
import { BREAKPOINT_MAX_PX, resolveResponsiveValue } from '@/lib/canvasDesign';
import { resolveDirectoryCarouselSource, resolveDirectoryCarouselOrganisationNameDisplay, presentDirectoryCarouselRecord, resolveDirectoryCarouselPerView } from './blocks/directoryCarouselSource.mjs';

// The provider owns one navigation/audience generation, never a global cache of
// cookie-bearing projections. The lazy renderer adopts its exact visit + seed.
export const DirectoryCarouselBootstrapContext = createContext(null);

export function createDirectoryCarouselVisitSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint32Array(2);
    globalThis.crypto.getRandomValues(bytes);
    return `${bytes[0].toString(36)}-${bytes[1].toString(36)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function directoryCarouselViewerIdentity({ authResolved, sessionValidated, memberInfo, memberRole }) {
  return [
    authResolved ? 'resolved' : 'pending', sessionValidated ? 'validated' : 'unvalidated',
    memberInfo?.id || '', memberInfo?.tenant_id || '', memberRole?.id || '',
    JSON.stringify(memberRole?.excluded_features || []),
    JSON.stringify(memberInfo?.member_excluded_features || []),
  ].join(':');
}

export function buildDirectoryCarouselQuery({ source = 'dynamic', directoryId, directorySlug, tenant, page = 1, limit, randomiseOrder = false, seed, organisationNameDisplay } = {}) {
  const params = new URLSearchParams();
  params.set('mode', 'carousel');
  if (tenant) params.set('tenant', tenant);
  params.set('source', source);
  params.set('organization_name_display', resolveDirectoryCarouselOrganisationNameDisplay(organisationNameDisplay));
  if (source === 'dynamic') {
    if (directoryId) params.set('directory_id', String(directoryId));
    else params.set('slug', String(directorySlug || ''));
  }
  params.set('page', String(Math.max(1, Number(page) || 1)));
  params.set('limit', String(Math.max(1, Math.min(Number(limit) || 1, 50))));
  if (randomiseOrder && seed) params.set('seed', String(seed));
  return params;
}

export function directoryCarouselQueryOptions({ source, directoryId, directorySlug, tenant, viewerIdentity, visitIdentity, organisationNameDisplay, randomiseOrder, seed }, apiPage = 1) {
  return {
    queryKey: ['canvas', 'public-dynamic-directory-carousel', tenant || '', viewerIdentity || '', visitIdentity || '',
      source || 'dynamic', directoryId || directorySlug || '',
      resolveDirectoryCarouselOrganisationNameDisplay(organisationNameDisplay), apiPage, 50, randomiseOrder ? String(seed || '') : ''],
    queryFn: async ({ signal }) => {
      const query = buildDirectoryCarouselQuery({ source, directoryId, directorySlug, tenant, page: apiPage, organisationNameDisplay, limit: 50, randomiseOrder, seed });
      const res = await fetch(`/api/public/dynamic-directory?${query}`, { credentials: 'include', signal });
      if (!res.ok) {
        let message = 'Directory carousel fetch failed';
        try {
          const body = await res.json();
          if (body?.error && ![401, 403, 404].includes(res.status)) message = body.error;
        } catch {}
        const error = new Error(message);
        error.status = res.status;
        throw error;
      }
      return res.json();
    },
    retry: false, retryOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    staleTime: 60_000, gcTime: 60_000, placeholderData: () => undefined,
  };
}

// Visible resources are dispatched first at high priority. The rest are low
// priority and bounded to two concurrent decodes/downloads after those settle.
export function warmDirectoryCarouselImages(batches, source, offset, perView) {
  if (typeof Image === 'undefined') return () => {};
  const urls = batches.flatMap(batch => (batch?.records || []).map(record =>
    presentDirectoryCarouselRecord(record, batch.entityType || (source === 'primary-member' ? 'member' : 'organization')).logo_url));
  const visible = [...new Set(urls.slice(offset, offset + perView).filter(Boolean))];
  const remaining = [...new Set(urls.filter(url => url && !visible.includes(url)))];
  let cancelled = false;
  const load = (url, priority) => new Promise(resolve => {
    if (cancelled) return resolve();
    const image = new Image();
    image.fetchPriority = priority;
    image.onload = image.onerror = resolve;
    image.src = url;
  });
  Promise.all(visible.map(url => load(url, 'high'))).then(async () => {
    await Promise.all([0, 1].map(async () => {
      while (!cancelled && remaining.length) await load(remaining.shift(), 'low');
    }));
  });
  return () => { cancelled = true; };
}

export function useDirectoryCarouselBootstrap({ page, navigationIdentity, enabled }) {
  const viewer = useLayoutContext();
  const viewerIdentity = directoryCarouselViewerIdentity(viewer);
  const tenant = publicClient.getTenantSlug() || '';
  const queryClient = useQueryClient();
  const sharedVisits = usePublicPageNavigation()?.carouselVisits;
  const scope = useMemo(() => {
    const key = JSON.stringify([tenant, viewerIdentity, navigationIdentity]);
    if (sharedVisits?.has(key)) return sharedVisits.get(key);
    const visit = { tenant, viewerIdentity, entries: new Map(), id: createDirectoryCarouselVisitSeed() };
    sharedVisits?.set(key, visit);
    return visit;
  }, [tenant, viewerIdentity, navigationIdentity, sharedVisits]);
  const blocks = [];
  const collect = node => {
    if (!node) return;
    if (node.type === 'directory-carousel') blocks.push(node);
    for (const child of node.sections || node.children || []) collect(child);
  };
  if (page?.builder_type === 'canvas') collect(page.canvas_design?.root);
  // Entries own this visit's identity and bootstrap attempt only. Configuration
  // changes create new keys; resize and ordinary rerenders retain the visit.
  for (const block of blocks || []) {
    if (block.type !== 'directory-carousel') continue;
    const content = block.content || {};
    const source = resolveDirectoryCarouselSource(content);
    if (!source.configured) continue;
    const key = directoryCarouselBlockKey(block);
    if (!scope.entries.has(key)) scope.entries.set(key, {
      ...source, tenant, viewerIdentity,
      visitIdentity: `${scope.id}:${block.id}`,
      organisationNameDisplay: content.organisationNameDisplay,
      randomiseOrder: content.randomiseOrder === true,
      seed: content.randomiseOrder === true ? createDirectoryCarouselVisitSeed() : null,
    });
  }
  useEffect(() => {
    if (!enabled || !viewer.authResolved || (viewer.memberInfo && (!viewer.sessionValidated
      || !viewer.memberRole || viewer.memberRole.id !== viewer.memberInfo.role_id))) return;
    let active = true;
    const cleanups = [];
    for (const block of blocks || []) {
      const entry = scope.entries.get(directoryCarouselBlockKey(block));
      if (!entry) continue;
      // fetchQuery retries failed queries on a later call regardless of
      // retryOnMount. Keep the one bootstrap attempt through layout remounts;
      // explicit renderer Retry still works, and a new visit gets a new entry.
      entry.initialRequest ||= queryClient.fetchQuery(directoryCarouselQueryOptions(entry));
      entry.initialRequest.then(batch => {
        if (!active) return;
        const bp = window.innerWidth <= BREAKPOINT_MAX_PX.mobile ? 'mobile' : window.innerWidth <= BREAKPOINT_MAX_PX.tablet ? 'tablet' : 'desktop';
        const value = block.content?.perView;
        const perView = resolveDirectoryCarouselPerView(resolveResponsiveValue(value, bp) ?? 3);
        cleanups.push(warmDirectoryCarouselImages([batch], entry.source, 0, perView));
      }).catch(() => { /* The renderer exposes the same query's error. */ });
    }
    return () => { active = false; cleanups.forEach(cleanup => cleanup()); };
  }, [scope, page?.canvas_design, enabled, viewer.authResolved, queryClient]);
  useEffect(() => {
    const dispose = () => {
    const filters = { predicate: query => query.queryKey[1] === 'public-dynamic-directory-carousel'
      && String(query.queryKey[4]).startsWith(`${scope.id}:`) };
    queryClient.cancelQueries(filters);
    queryClient.removeQueries(filters);
    };
    scope.dispose = dispose;
    // The navigation provider owns shared visits; child layout replacements
    // must not cancel and restart the same first-load request.
    return sharedVisits ? undefined : dispose;
  }, [scope, queryClient, sharedVisits]);
  // Eligibility controls dispatch, not visit ownership. During Back the page
  // can mount from its current projection before all request gates settle;
  // dropping this context then would create a second renderer-local visit.
  return scope;
}

export function directoryCarouselBlockKey(block) {
  const c = block.content || {};
  return JSON.stringify([block.id, resolveDirectoryCarouselSource(c).identity,
    resolveDirectoryCarouselOrganisationNameDisplay(c.organisationNameDisplay), c.randomiseOrder === true]);
}
