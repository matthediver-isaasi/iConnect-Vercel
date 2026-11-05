import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";
import CanvasPageRenderer from "../components/canvas/LazyCanvasPageRenderer";
import StaticHtmlPageRenderer from "../components/staticpage/StaticHtmlPageRenderer";
import PopupRuntime from "../components/popups/PopupRuntime";
import { useRef, useEffect } from "react";
import { startPopupDiscovery } from "../lib/popupDiscovery";
import { popupDiagnostic } from "../lib/popupDiagnostics";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { usePageLayoutDecision } from "@/contexts/LayoutContext";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import Events from "./Events";

const visibleErrorDecision = {
  publicChrome: "none",
  forcePublicLayout: true,
  forceBlankLayout: false,
};

function pageLayoutDecision(page, isLoggedIn) {
  if (page.hide_chrome) {
    return {
      publicChrome: "none",
      forcePublicLayout: false,
      forceBlankLayout: true,
    };
  }

  const layoutType = page.layout_type || "public";
  const forcePublicLayout =
    layoutType === "public" || (layoutType === "hybrid" && !isLoggedIn);
  return {
    publicChrome: forcePublicLayout ? (page.public_chrome || "both") : "both",
    forcePublicLayout,
    forceBlankLayout: false,
  };
}

export default function HomePageRedirect() {
  const location = useLocation();
  const { memberInfo, authResolved, sessionValidated, isAccessReady } = useMemberAccess();
  const {
    branding,
    loading: brandingLoading,
    error: brandingError,
    tenantSlug,
  } = useTenantBranding();
  const isCanvasPreview = new URLSearchParams(location.search).has("_canvasPreview");
  const isLoggedIn = authResolved && sessionValidated && !!memberInfo;
  const viewerIdentity = isLoggedIn ? `member:${memberInfo.id}` : "guest";
  const popupDiscovery = useRef(null);
  const pageAudience = isCanvasPreview
    ? "editor"
    : (isLoggedIn ? "member" : "guest");
  const tenantId = branding?.id || tenantSlug || null;
  const settingsQueryEnabled =
    authResolved && !brandingLoading && !brandingError && !!tenantId;

  const settingsQuery = useQuery({
    // This is discovery, not permission. Start alongside branding/session,
    // but keep consumption and the page read behind the existing gates.
    // Do not re-key when branding supplies its id. This caches only the public
    // homepage slug (as before), never a page payload or member authority.
    queryKey: ["home-page-setting", window.location.host, tenantSlug, pageAudience],
    queryFn: async () => {
      const response = await fetch("/api/public/portal-branding", {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Homepage settings request failed (${response.status})`);
      }
      const data = await response.json();
      return data.homePageSlug || null;
    },
    staleTime: 60000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const homePageSlug = settingsQuery.data;
  const pageQueryEnabled = settingsQueryEnabled && settingsQuery.isSuccess &&
    !settingsQuery.isFetching && !!homePageSlug;

  const pageQuery = useQuery({
    queryKey: ["public-home-page", tenantId, homePageSlug, pageAudience],
    queryFn: async ({ signal }) => {
      // Start eligibility alongside the page payload, not after Canvas content
      // and symbols finish loading. Rendering and selected-content authorization
      // remain behind the ordinary published-page/session/consent gates.
      popupDiscovery.current = !isCanvasPreview && (!memberInfo || (sessionValidated && isAccessReady))
        ? startPopupDiscovery(homePageSlug, viewerIdentity, signal) : null;
      const response = await fetch(
        `/api/public/page/${encodeURIComponent(homePageSlug)}`,
        { credentials: "include", signal }
      );
      if (!response.ok) {
        throw new Error(`Homepage request failed (${response.status})`);
      }
      const data = await response.json();
      if (!data.success || !data.page) {
        throw new Error("The configured homepage was not returned");
      }
      return {
        page: data.page,
        elements: data.elements || [],
        symbols: data.symbols,
      };
    },
    enabled: pageQueryEnabled,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });

  const settingsPending =
    brandingLoading ||
    !authResolved ||
    (settingsQueryEnabled && (settingsQuery.isPending || settingsQuery.isFetching));
  const pagePending =
    pageQueryEnabled && (pageQuery.isPending || pageQuery.isFetching);
  const prerequisiteFailure =
    brandingError || (!brandingLoading && !tenantId) || settingsQuery.error;
  const diagnosticPhase = isCanvasPreview ? "editor_preview" : !authResolved ? "sign_in_loading"
    : brandingLoading ? "branding_loading" : prerequisiteFailure ? "prerequisite_failed"
      : settingsPending ? "homepage_settings_loading" : pagePending ? "page_content_loading"
        : pageQuery.error ? "page_failed" : !homePageSlug ? "no_homepage_selected"
          : memberInfo && (!sessionValidated || !isAccessReady) ? "member_access_loading"
            : pageQuery.data?.page?.status !== "published" ? "page_not_published" : "page_ready";
  useEffect(() => { popupDiagnostic("homepage_stage", { reason: diagnosticPhase }); }, [diagnosticPhase]);

  let layoutDecision = null;
  if (!settingsPending && !pagePending) {
    if (prerequisiteFailure || pageQuery.error) {
      layoutDecision = visibleErrorDecision;
    } else if (!homePageSlug) {
      layoutDecision = {
        publicChrome: "both",
        forcePublicLayout: !isLoggedIn,
        forceBlankLayout: false,
      };
    } else if (pageQuery.data?.page) {
      layoutDecision = pageLayoutDecision(pageQuery.data.page, isLoggedIn);
    } else {
      layoutDecision = visibleErrorDecision;
    }
  }
  usePageLayoutDecision(layoutDecision);

  if (settingsPending || pagePending) {
    return (
      <div className="min-h-screen" data-testid="loading-home-page" aria-busy="true">
        <div className="sr-only">Loading homepage</div>
      </div>
    );
  }

  if (prerequisiteFailure) {
    return (
      <div className="min-h-screen flex items-center justify-center" role="alert">
        <div className="text-center max-w-md px-4">
          <h1 className="text-2xl font-bold mb-4">Homepage unavailable</h1>
          <p className="text-slate-600">
            We couldn't load the homepage settings. Please refresh and try again.
          </p>
        </div>
      </div>
    );
  }

  if (!homePageSlug) {
    return <Events />;
  }

  if (pageQuery.error || !pageQuery.data?.page) {
    return (
      <div className="min-h-screen flex items-center justify-center" role="alert">
        <div className="text-center max-w-md px-4">
          <h1 className="text-2xl font-bold mb-4">Homepage unavailable</h1>
          <p className="text-slate-600">
            The configured homepage could not be loaded. Please try again later.
          </p>
        </div>
      </div>
    );
  }

  const { page, symbols } = pageQuery.data;
  // The canonical homepage renders here, not through DynamicPage. Keep popup
  // delivery behind the same published-page and resolved-member boundaries.
  const popupRuntime = page.status === "published" && !isCanvasPreview && authResolved
    && (!memberInfo || (sessionValidated && isAccessReady))
    ? <PopupRuntime key={`${tenantId}|${page.id}|${viewerIdentity}`}
        page={page} viewerIdentity={viewerIdentity} initialDiscovery={popupDiscovery.current} />
    : null;
  if (page.builder_type === "ai_static") {
    return (
      <div className="w-full" data-testid="home-page-static">
        <StaticHtmlPageRenderer page={page} />
        {popupRuntime}
      </div>
    );
  }

  if (page.builder_type === "canvas") {
    return (
      <div className="w-full" data-testid="home-page-canvas">
        <CanvasPageRenderer page={page} symbols={symbols} />
        {popupRuntime}
      </div>
    );
  }

  const sortedElements = [...(pageQuery.data.elements || [])].sort(
    (a, b) => (a.display_order || 0) - (b.display_order || 0)
  );
  return (
    <div className="iedit-page-container">
      {popupRuntime}
      {sortedElements.map((element) => (
        <IEditElementRenderer
          key={element.id}
          element={element}
          memberInfo={memberInfo}
          isPreview={false}
        />
      ))}
    </div>
  );
}