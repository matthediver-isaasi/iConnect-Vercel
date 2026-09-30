import React, { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { usePageLayoutDecision } from "@/contexts/LayoutContext";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { ScreenReaderProvider } from "@/contexts/ScreenReaderContext";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";
import CanvasPageRenderer from "../components/canvas/CanvasPageRenderer";
import StaticHtmlPageRenderer from "../components/staticpage/StaticHtmlPageRenderer";

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

export default function ViewPage() {
  const location = useLocation();
  const {
    branding,
    loading: brandingLoading,
    error: brandingError,
    tenantSlug,
  } = useTenantBranding();
  const {
    memberInfo,
    organizationInfo,
    authResolved,
    sessionValidated,
  } = useMemberAccess();
  const pageSlug = new URLSearchParams(location.search).get("slug");
  const tenantId = branding?.id || tenantSlug || null;
  const isLoggedIn = authResolved && sessionValidated && !!memberInfo;
  const pageAudience = isLoggedIn ? "member" : "guest";
  const pageQueryEnabled =
    authResolved && !brandingLoading && !brandingError && !!tenantId && !!pageSlug;

  const pageQuery = useQuery({
    queryKey: ["iedit-page-by-slug", tenantId, pageSlug, pageAudience],
    queryFn: async () => {
      const result = await base44.entities.IEditPage.list();
      const pages = Array.isArray(result) ? result : [];
      return pages.find((page) =>
        page.slug === pageSlug && page.status === "published"
      ) || null;
    },
    enabled: pageQueryEnabled,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });

  const page = pageQuery.data;
  const needsElements =
    !!page?.id && page.builder_type !== "canvas" && page.builder_type !== "ai_static";
  const elementsQuery = useQuery({
    queryKey: ["iedit-page-elements", tenantId, page?.id, pageAudience],
    queryFn: async () => {
      const result = await base44.entities.IEditPageElement.list();
      const allElements = Array.isArray(result) ? result : [];
      return allElements
        .filter((element) => element.page_id === page.id)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    enabled: needsElements,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
  const elements = elementsQuery.data || [];

  const prerequisitesPending =
    brandingLoading ||
    !authResolved ||
    (pageQueryEnabled && (pageQuery.isPending || pageQuery.isFetching));
  const prerequisiteFailure = brandingError || (!brandingLoading && !tenantId);
  const layoutDecision = prerequisitesPending
    ? null
    : (prerequisiteFailure || pageQuery.error || !page
      ? visibleErrorDecision
      : pageLayoutDecision(page, isLoggedIn));
  usePageLayoutDecision(layoutDecision);

  useEffect(() => {
    if (!page) return;
    document.title = page.meta_title || page.title || branding?.name || "Portal";

    if (page.meta_description) {
      let metaDesc = document.querySelector('meta[name="description"]');
      if (!metaDesc) {
        metaDesc = document.createElement("meta");
        metaDesc.name = "description";
        document.head.appendChild(metaDesc);
      }
      metaDesc.content = page.meta_description;
    }
  }, [page, branding?.name]);

  useEffect(() => {
    if (!needsElements || elementsQuery.isPending || elementsQuery.isFetching || !location.hash) {
      return;
    }
    const anchorId = location.hash.substring(1);
    const scrollTimeout = setTimeout(() => {
      const targetElement = document.getElementById(anchorId);
      if (!targetElement) return;
      const header = document.querySelector('header.sticky, header[class*="sticky"]');
      const headerHeight = header ? header.offsetHeight : 0;
      const offsetPosition =
        targetElement.getBoundingClientRect().top +
        window.pageYOffset -
        headerHeight -
        20;
      window.scrollTo({ top: offsetPosition, behavior: "smooth" });
    }, 100);

    return () => clearTimeout(scrollTimeout);
  }, [
    elements,
    elementsQuery.isPending,
    elementsQuery.isFetching,
    location.hash,
    needsElements,
  ]);

  if (prerequisitesPending) {
    return (
      <div className="min-h-screen flex items-center justify-center" aria-busy="true">
        <div className="animate-pulse text-slate-600">Loading page...</div>
      </div>
    );
  }

  if (prerequisiteFailure || pageQuery.error) {
    return (
      <div className="min-h-screen flex items-center justify-center" role="alert">
        <div className="text-center max-w-md px-4">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">Page unavailable</h2>
          <p className="text-slate-600">
            We couldn't load this page. Please refresh and try again.
          </p>
        </div>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">Page not found</h2>
          <p className="text-slate-600">
            {pageSlug
              ? `The page "${pageSlug}" doesn't exist or hasn't been published yet.`
              : "No page specified"}
          </p>
        </div>
      </div>
    );
  }

  if (needsElements && (elementsQuery.isPending || elementsQuery.isFetching)) {
    return (
      <div className="min-h-screen flex items-center justify-center" aria-busy="true">
        <div className="animate-pulse text-slate-600">Loading page...</div>
      </div>
    );
  }

  if (elementsQuery.error) {
    return (
      <div className="min-h-screen flex items-center justify-center" role="alert">
        <p className="text-slate-600">The page content could not be loaded.</p>
      </div>
    );
  }

  const srOptimised = !!page.screen_reader_optimised;
  let content;
  if (page.builder_type === "ai_static") {
    content = <StaticHtmlPageRenderer page={page} />;
  } else if (page.builder_type === "canvas") {
    content = <CanvasPageRenderer page={page} />;
  } else {
    content = elements.length > 0
      ? elements.map((element) => (
          <IEditElementRenderer
            key={element.id}
            element={element}
            memberInfo={memberInfo}
            organizationInfo={organizationInfo}
          />
        ))
      : (
          <div className="min-h-screen flex items-center justify-center">
            <p className="text-slate-600">This page has no content yet.</p>
          </div>
        );
  }

  return (
    <ScreenReaderProvider optimised={srOptimised}>
      <div className="w-full" data-testid={`view-page-${pageSlug || "unknown"}`}>
        {srOptimised && (
          <h1 className="sr-only" data-testid="text-sr-page-h1">
            {page.title}
          </h1>
        )}
        {content}
      </div>
    </ScreenReaderProvider>
  );
}