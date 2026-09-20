import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { getTenantSlugFromLocation, publicClient } from "@/api/publicClient";
import { useQuery } from "@tanstack/react-query";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";
import CanvasPageRenderer from "../components/canvas/CanvasPageRenderer";
import StaticHtmlPageRenderer from "../components/staticpage/StaticHtmlPageRenderer";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { usePageLayoutDecision } from "@/contexts/LayoutContext";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { useMicrosite } from "@/contexts/MicrositeContext";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { useBelowFirstElementBanners } from "@/contexts/BannerContext";
import PortalHeroBanner from "@/components/banners/PortalHeroBanner";
import PageBannerDisplay from "@/components/banners/PageBannerDisplay";
import Articles from "./Articles";
import ArticleView from "./ArticleView";
import ArticleEditor from "./ArticleEditor";
import PublicArticles from "./PublicArticles";
import FormView from "./FormView";
import ErrorBoundary from "@/components/ErrorBoundary";
import { readPublicPage, DYNAMIC_PAGE_PENDING_TIMEOUT_MS } from "./dynamicPageRequest";
import {
  createDynamicPageRequestScope,
  getEarlyPublicPageRequest,
  isRelevantAccountStorageTransition,
  projectPublicPageDataForAudience,
} from "./dynamicPageFirstLoad";

function NeutralPageLoading({ testId, label = 'Loading page…' }) {
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-background"
      data-testid={testId}
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
        <span
          className="h-5 w-5 animate-spin rounded-full border-2 border-current border-r-transparent"
          aria-hidden="true"
        />
        <span>{label}</span>
      </div>
    </div>
  );
}

export default function DynamicPage() {
  // Task #2426: this component serves both /:slug (default site) and
  // /:micrositePrefix/:slug (microsite pages). In microsite mode the page is
  // resolved within the microsite and unknown prefixes render not-found.
  const { slug, micrositePrefix: routeMicrositePrefix } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { microsites, micrositesLoaded, micrositesError, activeMicrosite } = useMicrosite();
  const isMicrositeRoute = !!routeMicrositePrefix;
  const micrositeMatch = useMemo(() => {
    if (!isMicrositeRoute || !micrositesLoaded) return null;
    const prefix = routeMicrositePrefix.toLowerCase();
    return microsites.find((m) => m.path_prefix === prefix) || null;
  }, [isMicrositeRoute, micrositesLoaded, microsites, routeMicrositePrefix]);

  // Task #2764: a bare /{prefix} (single URL segment that matches an active
  // microsite prefix) should render that microsite's HOME page — mirroring the
  // crawler pre-renderer (api/public/prerender.js renderMicrositeHomePage) and
  // the SSR chrome resolver (renderHtml.js resolveMicrositeChromeForRequest).
  // MicrositeContext already keys activeMicrosite off the first path segment,
  // seeding it synchronously from the SSR-injected global on first paint and
  // from the fetched list on SPA navigation, so we resolve the home page slug
  // straight off it. A microsite with no home page (home_slug null) falls
  // through to the default-site bare-slug lookup, exactly as the pre-renderer.
  const barePrefixHome = useMemo(() => {
    if (isMicrositeRoute || !slug) return null;
    if (activeMicrosite && activeMicrosite.path_prefix === slug.toLowerCase() && activeMicrosite.home_slug) {
      return activeMicrosite;
    }
    return null;
  }, [isMicrositeRoute, slug, activeMicrosite]);
  const isMicrositeHomeRoute = !!barePrefixHome;

  // Unified microsite fetch parameters covering both the two-segment page route
  // (/{prefix}/{slug}) and the bare-prefix home route (/{prefix}).
  const isAnyMicrositeRoute = isMicrositeRoute || isMicrositeHomeRoute;
  const effectiveMicrosite = isMicrositeRoute ? micrositeMatch : barePrefixHome;
  const effectivePrefix = effectiveMicrosite?.path_prefix || null;
  const effectiveSlug = isMicrositeHomeRoute ? barePrefixHome.home_slug : slug;
  const earlyPublicRequest = useMemo(() => getEarlyPublicPageRequest({
    slug,
    routeMicrositePrefix,
    micrositeHome: barePrefixHome,
  }), [slug, routeMicrositePrefix, barePrefixHome]);
  const [publicRequestScope] = useState(createDynamicPageRequestScope);
  const publicTenantRequestIdentity = useMemo(() => {
    if (typeof window === 'undefined') return 'server';
    // Use the same tenant resolver as publicClient rather than snapshotting a
    // possibly stale localStorage value independently.
    return `${window.location.host}|${getTenantSlugFromLocation() || 'unresolved'}`;
  }, [location.search]);
  // When the Canvas Page Editor opens the live preview iframe, it appends
  // `?_canvasPreview=<nonce>`. In that mode we must bypass the publish gate
  // (and the public endpoint, which only returns published pages) only after
  // the positive capability check below, so an authorized editor can preview
  // and run accessibility audits against unpublished drafts. Anonymous
  // visitors keep the normal published/redacted projection even if they copy
  // the preview URL.
  const isCanvasPreview = useMemo(() => {
    try {
      return new URLSearchParams(location.search).has('_canvasPreview');
    } catch {
      return false;
    }
  }, [location.search]);
  // Dual-view accessibility audit (Task #925): when the canvas editor wants
  // to audit the "anonymous visitor" view of a hybrid page, it reloads the
  // preview iframe with `_publicView=1` alongside `_canvasPreview`. We honor
  // that flag by forcing the public layout (no portal header/sidebar) even
  // when the viewer is logged in. Data fetching auth is unchanged.
  const forcePublicPreview = useMemo(() => {
    try {
      const sp = new URLSearchParams(location.search);
      return sp.has('_canvasPreview') && sp.get('_publicView') === '1';
    } catch {
      return false;
    }
  }, [location.search]);
  const {
    memberInfo,
    memberRole,
    isAccessReady,
    isFeatureExcluded,
    authResolved,
    sessionValidated,
  } = useMemberAccess();
  // Start the public request with the same cookie context as the parallel
  // session request. The first resolved audience adopts this generation, so
  // checking→guest/member does not fetch twice. A later account transition
  // closes result consumption and advances the generation, preventing cached
  // member content from surviving logout or an account switch.
  const resolvedAudienceIdentity = sessionValidated && memberInfo?.id
    ? `member:${memberInfo.id}`
    : 'guest';
  const audienceGenerationRef = useRef({
    initialized: false,
    identity: null,
    authResolved: false,
  });
  const [audienceGeneration, setAudienceGeneration] = useState(0);
  const [storageInvalidationPending, setStorageInvalidationPending] = useState(false);
  const audienceTransitionPending = authResolved
    && audienceGenerationRef.current.initialized
    && audienceGenerationRef.current.identity !== resolvedAudienceIdentity;
  useEffect(() => {
    const tracker = audienceGenerationRef.current;
    // Any observed auth reset starts a fresh request generation, even when it
    // ultimately resolves to the same member id. Cookie-backed sessions can
    // change during revalidation, so the old raw response cannot cross it.
    if (!authResolved) {
      if (tracker.initialized && tracker.authResolved) {
        tracker.authResolved = false;
        setAudienceGeneration((current) => current + 1);
      }
      return;
    }
    setStorageInvalidationPending(false);
    if (!tracker.initialized) {
      tracker.initialized = true;
      tracker.identity = resolvedAudienceIdentity;
      tracker.authResolved = true;
      return;
    }
    tracker.authResolved = true;
    if (tracker.identity !== resolvedAudienceIdentity) {
      tracker.identity = resolvedAudienceIdentity;
      setAudienceGeneration((current) => current + 1);
    }
  }, [authResolved, resolvedAudienceIdentity]);
  useEffect(() => {
    const onStorage = (event) => {
      if (!isRelevantAccountStorageTransition(event)) return;
      // This listener is deliberately independent of the auth provider. It
      // fences both query keys immediately even when the storage switch occurs
      // before the very first auth response has initialized our tracker.
      setStorageInvalidationPending(true);
      setAudienceGeneration((current) => current + 1);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // Preview mode is only honoured after a positive capability check. A bare
  // `?_canvasPreview=…` parameter is not an authorization signal: anonymous
  // visitors must stay on the public projection, and a member must have a
  // validated session plus the page-editor feature.
  //
  // Tenant-admin sessions do not populate `memberInfo`, so validate that
  // session independently through the tenant-user endpoint. Requiring a
  // completed, non-fetching query here is important when an admin session
  // expires: React Query can retain stale data while it refetches, but stale
  // data must never keep the editor audience enabled.
  const tenantAdminAuthQuery = useQuery({
    queryKey: [
      'canvas-preview-tenant-admin-auth',
      isCanvasPreview,
      authResolved,
      sessionValidated,
      memberInfo?.id || 'anonymous',
    ],
    queryFn: async () => {
      const response = await fetch('/api/auth/tenant-user-me', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      return data?.authenticated === true && data?.tenantUser ? data : null;
    },
    enabled: isCanvasPreview && authResolved && !memberInfo,
    staleTime: 0,
    retry: false,
    refetchOnMount: 'always',
  });

  const canPreviewDrafts = useMemo(() => {
    if (!isCanvasPreview) return false;
    if (memberInfo) {
      if (!authResolved || !sessionValidated || !isAccessReady) return false;
      return !isFeatureExcluded('site-builder.page-editor');
    }
    return tenantAdminAuthQuery.isSuccess
      && !tenantAdminAuthQuery.isFetching
      && !!tenantAdminAuthQuery.data?.authenticated
      && !!tenantAdminAuthQuery.data?.tenantUser;
  }, [
    isCanvasPreview,
    memberInfo,
    authResolved,
    sessionValidated,
    isAccessReady,
    isFeatureExcluded,
    tenantAdminAuthQuery.data,
    tenantAdminAuthQuery.isFetching,
    tenantAdminAuthQuery.isSuccess,
  ]);
  const { branding, loading: brandingLoading, error: brandingError } = useTenantBranding();
  
  // Get banners that should appear below the first element
  // Must be called unconditionally at the top to follow React's Rules of Hooks
  const belowFirstElementBanners = useBelowFirstElementBanners();
  
  // Use shared ArticleUrlContext instead of duplicating settings query
  const { 
    displayName: articleDisplayName, 
    urlSlug, 
    viewSlug, 
    editorSlug, 
    mySlug, 
    publicSlug, 
    isCustomSlug, 
    isLoading: articleUrlLoading 
  } = useArticleUrl();

  const dynamicArticleRoute = useMemo(() => {
    // Microsite URLs never map to dynamic article routes.
    if (isMicrositeRoute || isMicrositeHomeRoute) return null;
    // Only intercept dynamic routes if we have a custom slug configured
    if (!isCustomSlug || !slug || articleUrlLoading) return null;
    
    const slugLower = slug.toLowerCase();
    
    if (slugLower === urlSlug.toLowerCase()) {
      return { component: 'Articles', displayName: articleDisplayName };
    }
    if (slugLower === viewSlug.toLowerCase()) {
      return { component: 'ArticleView', displayName: articleDisplayName };
    }
    if (slugLower === editorSlug.toLowerCase()) {
      return { component: 'ArticleEditor', displayName: articleDisplayName };
    }
    if (slugLower === mySlug.toLowerCase()) {
      // MyArticles is now integrated into Articles page - redirect there
      return { component: 'Articles', displayName: articleDisplayName };
    }
    if (slugLower === publicSlug.toLowerCase()) {
      return { component: 'PublicArticles', displayName: articleDisplayName };
    }
    
    return null;
  }, [articleDisplayName, urlSlug, viewSlug, editorSlug, mySlug, publicSlug, isCustomSlug, articleUrlLoading, slug, isMicrositeRoute, isMicrositeHomeRoute]);

  // The page query is only enabled once its route prerequisites are met. On a
  // microsite route that means the microsites list has loaded AND the prefix
  // matched a real microsite. Keep this in a named flag so we can also tell
  // "query enabled but not yet resolved" apart from "resolved with no page".
  const previewAuthPending = isCanvasPreview && (
    !authResolved || (memberInfo ? !isAccessReady :
      (!tenantAdminAuthQuery.isFetched || tenantAdminAuthQuery.isFetching))
  );
  const routePrerequisitesReady = micrositesLoaded && !articleUrlLoading &&
    !brandingLoading && authResolved && !previewAuthPending &&
    !audienceTransitionPending && !storageInvalidationPending;
  const routeMetadataError = micrositesError || brandingError;

  // This transport intentionally does not wait for auth, branding, article
  // settings, or (for an explicit two-segment URL) the microsite catalogue.
  // Its result remains unconsumed until all route/audience checks below settle.
  const {
    data: earlyPublicPageResult,
    isFetched: earlyPublicPageFetched,
    error: earlyPublicPageError,
  } = useQuery({
    queryKey: [
      'iedit-dynamic-page-public',
      publicRequestScope,
      publicTenantRequestIdentity,
      earlyPublicRequest?.micrositePrefix || null,
      earlyPublicRequest?.slug || null,
      audienceGeneration,
    ],
    queryFn: () => readPublicPage(() => publicClient.getPage(
      earlyPublicRequest.slug,
      earlyPublicRequest.micrositePrefix,
    )),
    enabled: !!earlyPublicRequest
      && !audienceTransitionPending
      && !storageInvalidationPending
      && (!isCanvasPreview || (!previewAuthPending && !canPreviewDrafts)),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const pageQueryEnabled = routePrerequisitesReady && !routeMetadataError && !earlyPublicPageError &&
    !!slug && !dynamicArticleRoute && (canPreviewDrafts || earlyPublicPageFetched) &&
    (!isMicrositeRoute || (micrositesLoaded && !!micrositeMatch));

  // Fetch page and elements together using public endpoint first, fall back to authenticated
  // Public page payloads can be redacted for a guest and full for a validated
  // member. Re-keying on the resolved audience refreshes the page after login
  // without putting editor preview drafts through a session-driven overwrite.
  const pageAudience = canPreviewDrafts
    ? 'editor'
    : (authResolved
      ? (sessionValidated && !!memberInfo ? 'member' : 'guest')
      : 'checking');
  const { data: pageData, isLoading: pageLoading, isFetching: pageFetching, isFetched: pageFetched, error: pageError } = useQuery({
    queryKey: ['iedit-dynamic-page', publicRequestScope, branding?.id, effectivePrefix, effectiveSlug, canPreviewDrafts ? 'preview' : 'live', pageAudience, memberInfo?.id, audienceGeneration],
    queryFn: async () => {
      if (!canPreviewDrafts && earlyPublicPageResult?.data) {
        return projectPublicPageDataForAudience(
          earlyPublicPageResult.data,
          sessionValidated && !!memberInfo,
        );
      }
      // Task #2426/#2764: microsite pages (both /{prefix}/{slug} and the bare
      // /{prefix} home page) are public-only — resolve strictly via the public
      // endpoint scoped to the microsite prefix (no authenticated fallback:
      // bare-slug auth reads would leak pages across microsites).
      if (isAnyMicrositeRoute && !canPreviewDrafts) {
        return { page: null, elements: [] };
      }
      // Once a verified editor capability is available, skip the public
      // endpoint entirely — it only serves published pages, and the preview
      // iframe is explicitly authoring an unpublished draft. An unverified
      // `_canvasPreview` URL must stay on the public projection.
      // Fall back to authenticated endpoints for protected pages or logged-in users
      const pages = await base44.entities.IEditPage.list({ 
        filter: {
          slug: effectiveSlug,
          ...(isAnyMicrositeRoute ? { microsite_id: effectiveMicrosite.id } : {}),
        },
      });
      const page = pages[0] || null;
      if (!page) return { page: null, elements: [] };

      // Default (non-prefixed) path: a page assigned to a microsite is only
      // served under its prefix. Mirror the public endpoint's bare-slug guard
      // (`!microsite && page.microsite_id` → 404) so the authenticated fallback
      // does not leak microsite pages at their bare /{slug} URL.
      if (isAnyMicrositeRoute
        ? page.microsite_id !== effectiveMicrosite.id
        : !!page.microsite_id) return { page: null, elements: [] };

      // Static AI-generated pages (Task #3371) carry their whole body on the
      // page row (static_html/static_css) — no element rows, no symbols.
      if (page.builder_type === 'ai_static') {
        return { page, elements: [] };
      }

      // Canvas Builder pages have no i_edit_page_element rows — their
      // layout lives in canvas_design on the page row itself. Skip the
      // element fetch to save a round trip.
      if (page.builder_type === 'canvas') {
        // This path is authenticated (preview iframe or a logged-in viewer of
        // a hybrid/member page). The public page endpoint did not run, so pull
        // symbol designs from the authenticated endpoint and embed them so the
        // renderer resolves symbols without depending on the published-only
        // public fallback — this is what makes preview show symbol children
        // even before the page/symbol is published.
        let symbols;
        try {
          const r = await fetch('/api/canvas-symbols?full=1', { credentials: 'include' });
          if (r.ok) {
            const body = await r.json();
            symbols = body?.symbols;
          }
        } catch (e) {
          // Best-effort: fall back to the public fetch inside the renderer.
        }
        return { page, elements: [], symbols };
      }

      const elements = await base44.entities.IEditPageElement.list({ 
        filter: { page_id: page.id },
        sort: { display_order: 'asc' }
      });
      return { page, elements };
    },
    enabled: pageQueryEnabled,
    staleTime: 0,
    retry: false,
  });

  const page = pageData?.page;
  const elements = pageData?.elements || [];
  const elementsLoading = pageLoading;

  // "Not settled" = the query is enabled but hasn't returned yet. During the
  // brief idle→fetching transition React Query's isLoading is still false, so
  // without this guard the `!page` not-found branch would flash for a frame
  // before the real page paints. Treat that window as loading instead.
  const pageQueryPending = pageQueryEnabled && !pageFetched;

  // Set page title and meta description
  useEffect(() => {
    if (page) {
      document.title = page.meta_title || page.title || branding?.name || 'Portal';
      
      if (page.meta_description) {
        let metaDesc = document.querySelector('meta[name="description"]');
        if (!metaDesc) {
          metaDesc = document.createElement('meta');
          metaDesc.name = 'description';
          document.head.appendChild(metaDesc);
        }
        metaDesc.content = page.meta_description;
      }
    }
  }, [page]);

  // Handle anchor scrolling after elements are loaded
  useEffect(() => {
    // Only proceed if we have elements loaded and there's a hash in the URL
    if (elements.length > 0 && !elementsLoading && location.hash) {
      const anchorId = location.hash.substring(1); // Remove the # prefix
      let cancelled = false;
      
      const scrollToAnchor = () => {
        const targetElement = document.getElementById(anchorId);
        console.log('[Anchor Debug] Scrolling to anchor:', anchorId, 'Element found:', !!targetElement);
        
        if (targetElement) {
          // Get the sticky header height to offset the scroll position
          const header = document.querySelector('header.sticky, header[class*="sticky"]');
          const headerHeight = header ? header.offsetHeight : 0;
          
          // Calculate the target scroll position with header offset
          const elementPosition = targetElement.getBoundingClientRect().top;
          const offsetPosition = elementPosition + window.pageYOffset - headerHeight - 20;
          
          console.log('[Anchor Debug] Final scroll calculation:', {
            elementPosition,
            pageYOffset: window.pageYOffset,
            headerHeight,
            offsetPosition,
            documentHeight: document.body.scrollHeight
          });
          
          window.scrollTo({
            top: offsetPosition,
            behavior: 'smooth'
          });
        }
      };
      
      // Wait for document height to stabilize (indicates images/content have loaded)
      let lastHeight = 0;
      let stableCount = 0;
      const checkInterval = setInterval(() => {
        if (cancelled) {
          clearInterval(checkInterval);
          return;
        }
        
        const currentHeight = document.body.scrollHeight;
        console.log('[Anchor Debug] Checking height stability:', { currentHeight, lastHeight, stableCount });
        
        if (currentHeight === lastHeight) {
          stableCount++;
          // Consider stable after 3 consecutive checks (600ms of no change)
          if (stableCount >= 3) {
            clearInterval(checkInterval);
            scrollToAnchor();
          }
        } else {
          stableCount = 0;
          lastHeight = currentHeight;
        }
      }, 200);
      
      // Fallback: scroll after 3 seconds max regardless of stability
      const fallbackTimeout = setTimeout(() => {
        if (!cancelled) {
          clearInterval(checkInterval);
          console.log('[Anchor Debug] Fallback timeout reached, scrolling now');
          scrollToAnchor();
        }
      }, 3000);

      return () => {
        cancelled = true;
        clearInterval(checkInterval);
        clearTimeout(fallbackTimeout);
      };
    }
  }, [elements, elementsLoading, location.hash]);

  // Check if page is accessible
  const isPublished = page?.status === 'published';
  const layoutType = page?.layout_type || 'public';
  const isMemberPage = layoutType === 'member';
  const isHybridPage = layoutType === 'hybrid';
  const isPublicPage = layoutType === 'public';
  // Never use retained member state as an audience signal after the session
  // has become unresolved/invalid.
  const isLoggedIn = authResolved && sessionValidated && !!memberInfo;

  // Check for redirect mappings when page is not found (default site only)
  const shouldCheckRedirect = routePrerequisitesReady && !pageError && pageFetched && !pageFetching && !page && !dynamicArticleRoute && !!slug && !isAnyMicrositeRoute;
  const { data: redirectResult, isLoading: redirectLoading, isError: redirectError, error: redirectRequestError } = useQuery({
    queryKey: ['redirect-resolve', branding?.id, slug],
    queryFn: async () => {
      const currentPath = '/' + slug;
      const response = await fetch(`/api/redirects/resolve?path=${encodeURIComponent(currentPath)}`);
      if (!response.ok) throw new Error('Unable to check page redirects.');
      return response.json();
    },
    enabled: shouldCheckRedirect,
    staleTime: 60000,
    retry: false,
  });

  // Task #2785: form fallback — when the page lookup AND redirect lookup both
  // miss for a top-level slug (default site only), check whether an active
  // form matches the slug. If so we render the FormView experience at the
  // pretty URL (/{form-slug}) instead of the not-found screen.
  const redirectMissed = shouldCheckRedirect &&
    redirectResult !== undefined && !redirectError && !redirectLoading && !redirectResult?.found;
  const { data: fallbackForm, isLoading: formFallbackLoading, isFetched: formFallbackFetched, error: formFallbackError } = useQuery({
    queryKey: ['public-form-by-slug', branding?.id, slug, pageAudience, memberInfo?.id],
    queryFn: async () => {
      try {
        const form = await publicClient.getForm(slug, { authenticated: !!memberInfo });
        return form || null;
      } catch (e) {
        // A policy-denied form still exists at this pretty URL. Preserve the
        // structured access result so FormView can render its shared sign-in
        // or access-requirements state instead of collapsing to "not found".
        if (e?.errorData?.access) {
          return { __access: e.errorData.access };
        }
        if (e?.status === 404) return null;
        throw e;
      }
    },
    enabled: redirectMissed,
    retry: false,
    staleTime: 60000
  });
  const formFallbackPending = redirectMissed && (!formFallbackFetched || formFallbackLoading);
  const hasFormFallback = redirectMissed && !!fallbackForm;

  const unknownMicrosite = isMicrositeRoute && micrositesLoaded && !micrositeMatch;
  const terminalPage = pageFetched && !pageFetching;
  const fallbackSettled = !shouldCheckRedirect || (
    redirectMissed && formFallbackFetched && !formFallbackLoading
  );
  const pageRequestError = routeMetadataError || earlyPublicPageError || pageError ||
    redirectRequestError || formFallbackError;
  const routePending = !routePrerequisitesReady || pageLoading || pageQueryPending ||
    (!canPreviewDrafts && !!earlyPublicRequest && !earlyPublicPageFetched) ||
    (shouldCheckRedirect && redirectResult === undefined && !redirectError) ||
    formFallbackPending || (isMemberPage && isLoggedIn && !isAccessReady);
  const pendingScope = `${location.key}|${audienceGeneration}|${publicTenantRequestIdentity}`;
  const [timedOutScope, setTimedOutScope] = useState(null);
  useEffect(() => {
    if (!routePending || pageRequestError) {
      setTimedOutScope(null);
      return;
    }
    const timer = setTimeout(() => setTimedOutScope(pendingScope), DYNAMIC_PAGE_PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [routePending, pageRequestError, pendingScope]);
  const pendingTimedOut = routePending && timedOutScope === pendingScope;
  const terminalError = pageRequestError || pendingTimedOut;
  const decisionReady = !!terminalError || (routePrerequisitesReady && (
    !!routeMetadataError || !!dynamicArticleRoute || unknownMicrosite || (terminalPage && (!!page || fallbackSettled))
  ));
  const shouldForcePublic = dynamicArticleRoute
    ? dynamicArticleRoute.component === 'PublicArticles' || !isLoggedIn
    : page ? (forcePublicPreview || isPublicPage || (isHybridPage && !isLoggedIn))
      : hasFormFallback ? !isLoggedIn : true;
  usePageLayoutDecision(decisionReady ? {
    forcePublicLayout: shouldForcePublic,
    forceBlankLayout: !!page?.hide_chrome || !!fallbackForm?.blank_layout,
    // A missing/error response proves no chrome settings. Render its message,
    // not a default header/footer; forms/articles have an explicit policy.
    publicChrome: terminalError || fallbackForm?.__access ? 'none' : dynamicArticleRoute || hasFormFallback ? 'both'
      : page ? (page.public_chrome || 'both') : 'none',
  } : null);

  // Handle 404 - check redirect mappings first, then fall back to default behavior
  // We need to wait for access state to be determined:
  // - For guests: memberInfo is null (from localStorage init, not undefined)
  // - For logged-in users: isAccessReady will be true after role is loaded
  const isGuest = memberInfo === null;
  const authCheckComplete = isGuest || isAccessReady;
  
  // Determine if redirect check is complete:
  // - If we should check redirects, wait for the result to be defined (not just not loading)
  // - If we shouldn't check redirects, consider it complete
  const redirectCheckComplete = shouldCheckRedirect 
    ? ((redirectResult !== undefined || redirectError) && !redirectLoading)
    : true;
  
  useEffect(() => {
    // Wait for page loading to complete and we're in a 404 scenario
    if (pageLoading || page || dynamicArticleRoute) {
      return;
    }
    
    // If we should check redirects, wait for that to complete
    if (!redirectCheckComplete) {
      console.log('[DynamicPage] Waiting for redirect check to complete...');
      return;
    }
    
    // Check if we have a redirect mapping
    if (redirectResult?.found && redirectResult?.target_url) {
      console.log('[DynamicPage] Redirect mapping found:', redirectResult.target_url);
      // Handle external vs internal redirects
      if (redirectResult.target_url.startsWith('http://') || redirectResult.target_url.startsWith('https://')) {
        window.location.href = redirectResult.target_url;
      } else {
        navigate(redirectResult.target_url, { replace: true });
      }
      return;
    }
    
  }, [page, pageLoading, dynamicArticleRoute, redirectCheckComplete, redirectResult, authCheckComplete, memberInfo, memberRole, navigate]);

  // Debug: Log what's being rendered
  console.log('[DynamicPage] slug:', slug);
  console.log('[DynamicPage] dynamicArticleRoute:', dynamicArticleRoute);
  console.log('[DynamicPage] mySlug:', mySlug, 'isCustomSlug:', isCustomSlug);

  if (terminalError) {
    return (
      <div className="min-h-screen flex items-center justify-center" role="alert">
        <div>
          <h1 className="text-2xl font-bold mb-4">Page unavailable</h1>
          <p>{pendingTimedOut
            ? 'Loading this page took too long. Please try again.'
            : "We couldn't load this page. Please try again."}</p>
          <button type="button" className="underline mr-4" onClick={() => window.location.reload()}>
            Retry loading page
          </button>
          <a href="/">Go to homepage</a>
        </div>
      </div>
    );
  }

  if (dynamicArticleRoute) {
    console.log('[DynamicPage] Rendering component:', dynamicArticleRoute.component);
    let routeEl = null;
    switch (dynamicArticleRoute.component) {
      case 'Articles':
        routeEl = <Articles />;
        break;
      case 'ArticleView':
        routeEl = <ArticleView />;
        break;
      case 'ArticleEditor':
        routeEl = <ArticleEditor />;
        break;
      case 'PublicArticles':
        routeEl = <PublicArticles />;
        break;
      default:
        routeEl = null;
    }
    return (
      <ErrorBoundary name={`DynamicArticleRoute:${dynamicArticleRoute.component}`}>
        {routeEl}
      </ErrorBoundary>
    );
  }

  // Task #2426: microsite route gating. Wait for the microsites list, then
  // treat an unknown prefix as a plain 404 (same as the old catch-all).
  if (!routePrerequisitesReady) {
    return <NeutralPageLoading testId="loading-microsite" />;
  }
  if (isMicrositeRoute && !micrositeMatch) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="page-not-found">
        <div className="text-center max-w-md px-4">
          <h1 className="text-4xl font-bold mb-4" data-testid="text-not-found-title">Page not found</h1>
          <p className="text-muted-foreground mb-6" data-testid="text-not-found-message">
            The page you're looking for doesn't exist or has been removed.
          </p>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover-elevate"
            data-testid="link-go-home"
          >
            Go to homepage
          </a>
        </div>
      </div>
    );
  }

  if (
    pageLoading || elementsLoading || pageQueryPending ||
    (!canPreviewDrafts && !!earlyPublicRequest && !earlyPublicPageFetched)
  ) {
    return <NeutralPageLoading testId="loading-dynamic-page" />;
  }

  if (!page) {
    if (redirectLoading || (shouldCheckRedirect && !redirectCheckComplete) || formFallbackPending) {
      return <NeutralPageLoading testId="page-checking-redirect" label="Checking page…" />;
    }

    // Task #2785: an active form matching the top-level slug renders the full
    // FormView experience at the pretty URL (prefill params, drafts, contract
    // signing and blank-layout handling all live inside FormView itself).
    if (hasFormFallback) {
      return (
        <ErrorBoundary name={`DynamicFormFallback:${slug}`}>
          <FormView slug={slug} />
        </ErrorBoundary>
      );
    }

    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="page-not-found">
        <div className="text-center max-w-md px-4">
          <h1 className="text-4xl font-bold mb-4" data-testid="text-not-found-title">Page not found</h1>
          <p className="text-muted-foreground mb-6" data-testid="text-not-found-message">
            The page you're looking for doesn't exist or has been removed.
          </p>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover-elevate"
            data-testid="link-go-home"
          >
            Go to homepage
          </a>
        </div>
      </div>
    );
  }

  if (!isPublished && !canPreviewDrafts) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="page-not-published">
        <div className="text-center">
          <p className="text-slate-600">
            This page is currently being updated. Please check back soon.
          </p>
        </div>
      </div>
    );
  }

  if (isMemberPage && isLoggedIn && !isAccessReady) {
    return <NeutralPageLoading testId="loading-access-check" label="Checking access…" />;
  }

  if (isMemberPage && !isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="page-requires-login">
        <div className="text-center">
          <p className="text-slate-600 mb-6">
            This page is only accessible to logged-in members.
          </p>
          <a 
            href="/Home" 
            className="inline-flex items-center justify-center px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            data-testid="link-login"
          >
            Log In
          </a>
        </div>
      </div>
    );
  }

  // Static AI-generated pages (Task #3371): pre-sanitized HTML + page-scoped
  // CSS stored on the row itself; rendered read-only inside normal chrome.
  if (page.builder_type === 'ai_static') {
    return (
      <div className="w-full" data-testid={`dynamic-page-${slug}`}>
        <StaticHtmlPageRenderer page={page} />
      </div>
    );
  }

  // Canvas Builder pages render via their own design document instead of
  // the stacked IEditPageElement list. Phase 1 only ships a stub renderer.
  if (page.builder_type === 'canvas') {
    return (
      <div className="w-full" data-testid={`dynamic-page-${slug}`}>
        <CanvasPageRenderer
          page={page}
          symbols={pageData?.symbols}
          editorPreview={canPreviewDrafts && !forcePublicPreview}
        />
      </div>
    );
  }

  // Render the page content - Layout handles the appropriate wrapper (PublicLayout or sidebar)
  return (
    <div className="w-full" data-testid={`dynamic-page-${slug}`}>
      {elements.map((element, index) => (
        <React.Fragment key={element.id}>
          <IEditElementRenderer element={element} memberInfo={memberInfo} />
          {/* Insert below-first-element banners after the first element */}
          {index === 0 && belowFirstElementBanners.length > 0 && (
            <div className="w-full">
              {belowFirstElementBanners.map((banner) => (
                banner.banner_type === 'image'
                  ? <PageBannerDisplay key={banner.id} banner={banner} />
                  : <PortalHeroBanner key={banner.id} banner={banner} />
              ))}
            </div>
          )}
        </React.Fragment>
      ))}
      
      {elements.length === 0 && (
        <div className="min-h-screen flex items-center justify-center" data-testid="page-no-content">
          <div className="text-center">
            <p className="text-slate-600">This page is currently being updated. Please check back soon.</p>
          </div>
        </div>
      )}
    </div>
  );
}
