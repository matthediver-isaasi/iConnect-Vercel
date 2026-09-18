import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";
import CanvasPageRenderer from "../components/canvas/CanvasPageRenderer";
import StaticHtmlPageRenderer from "../components/staticpage/StaticHtmlPageRenderer";
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
  const { memberInfo, authResolved, sessionValidated } = useMemberAccess();
  const {
    branding,
    loading: brandingLoading,
    error: brandingError,
    tenantSlug,
  } = useTenantBranding();
  const isCanvasPreview = new URLSearchParams(location.search).has("_canvasPreview");
  const isLoggedIn = authResolved && sessionValidated && !!memberInfo;
  const pageAudience = isCanvasPreview
    ? "editor"
    : (isLoggedIn ? "member" : "guest");
  const tenantId = branding?.id || tenantSlug || null;
  const settingsQueryEnabled =
    authResolved && !brandingLoading && !brandingError && !!tenantId;

  const settingsQuery = useQuery({
    queryKey: ["home-page-setting", tenantId, pageAudience],
    queryFn: async () => {
      const response = await fetch("/api/public/portal-branding", {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`Homepage settings request failed (${response.status})`);
      }
      const data = await response.json();
      return data.homePageSlug || null;
    },
    enabled: settingsQueryEnabled,
    staleTime: 60000,
    retry: false,
  });
  const homePageSlug = settingsQuery.data;

  const pageQuery = useQuery({
    queryKey: ["public-home-page", tenantId, homePageSlug, pageAudience],
    queryFn: async () => {
      const response = await fetch(
        `/api/public/page/${encodeURIComponent(homePageSlug)}`,
        { credentials: "include" }
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
    enabled: settingsQueryEnabled && !!homePageSlug,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });

  const settingsPending =
    brandingLoading ||
    !authResolved ||
    (settingsQueryEnabled && (settingsQuery.isPending || settingsQuery.isFetching));
  const pagePending =
    !!homePageSlug && (pageQuery.isPending || pageQuery.isFetching);
  const prerequisiteFailure =
    brandingError || (!brandingLoading && !tenantId) || settingsQuery.error;

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
  if (page.builder_type === "ai_static") {
    return (
      <div className="w-full" data-testid="home-page-static">
        <StaticHtmlPageRenderer page={page} />
      </div>
    );
  }

  if (page.builder_type === "canvas") {
    return (
      <div className="w-full" data-testid="home-page-canvas">
        <CanvasPageRenderer page={page} symbols={symbols} />
      </div>
    );
  }

  const sortedElements = [...(pageQuery.data.elements || [])].sort(
    (a, b) => (a.display_order || 0) - (b.display_order || 0)
  );
  return (
    <div className="iedit-page-container">
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