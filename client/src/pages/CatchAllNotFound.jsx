import { useEffect, useLayoutEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { getRedirectTenantIdentity, getUnknownPageRedirectTarget, resolveUnknownPage } from "./unknownPageRedirect";
import { createDynamicPageRequestScope } from "./dynamicPageFirstLoad";

export default function CatchAllNotFound() {
  const location = useLocation();
  const navigate = useNavigate();
  const { setForcePublicLayout, setChromeReady } = useLayoutContext();

  const fullPath = location.pathname;
  const [requestScope] = useState(createDynamicPageRequestScope);
  const tenantIdentity = getRedirectTenantIdentity();

  useLayoutEffect(() => {
    setForcePublicLayout(true);
    // Defensively release the Layout chrome gate before paint. The previous
    // route may have left it closed (e.g. DynamicPage's slug-change effect)
    // and this component never opens it on its own — leaving the not-found
    // UI hidden behind `visibility: hidden`.
    setChromeReady(true);
    return () => {
      setForcePublicLayout(false);
    };
  }, [setForcePublicLayout, setChromeReady]);

  const { data: redirectResult, isLoading: redirectLoading, error: redirectError } = useQuery({
    queryKey: ['redirect-resolve', requestScope, tenantIdentity, fullPath, location.key],
    queryFn: ({ signal }) => resolveUnknownPage(fullPath, signal),
    enabled: !!fullPath,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const redirectTarget = getUnknownPageRedirectTarget(redirectResult, fullPath);

  useEffect(() => {
    if (redirectError || redirectLoading || redirectResult === undefined) {
      return;
    }

    if (redirectTarget) {
      if (redirectTarget.startsWith('http://') || redirectTarget.startsWith('https://')) {
        window.location.replace(redirectTarget);
      } else {
        navigate(redirectTarget, { replace: true });
      }
    }
  }, [redirectResult, redirectTarget, redirectError, redirectLoading, navigate]);

  if (redirectError) {
    return (
      <div className="min-h-screen flex items-center justify-center" role="alert">
        <div>
          <h1 className="text-2xl font-bold mb-4">Page unavailable</h1>
          <p>We couldn't check this page. Please try again.</p>
          <button type="button" className="underline" onClick={() => window.location.reload()}>Try again</button>
        </div>
      </div>
    );
  }

  if (redirectLoading || (redirectResult === undefined)) {
    return (
      <div className="min-h-screen" data-testid="page-checking-redirect" aria-busy="true">
        <div className="sr-only">Checking page...</div>
      </div>
    );
  }

  if (redirectTarget) {
    return (
      <div className="min-h-screen" data-testid="page-redirecting" aria-busy="true">
        <div className="sr-only">Redirecting...</div>
      </div>
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
