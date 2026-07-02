import { useEffect, useLayoutEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useLayoutContext } from "@/contexts/LayoutContext";

export default function CatchAllNotFound() {
  const location = useLocation();
  const navigate = useNavigate();
  const { setForcePublicLayout, setChromeReady } = useLayoutContext();

  const fullPath = location.pathname;

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

  const { data: redirectResult, isLoading: redirectLoading } = useQuery({
    queryKey: ['redirect-resolve', fullPath],
    queryFn: async () => {
      const response = await fetch(`/api/redirects/resolve?path=${encodeURIComponent(fullPath)}`);
      if (!response.ok) return { found: false };
      return response.json();
    },
    enabled: !!fullPath,
    staleTime: 60000
  });

  useEffect(() => {
    if (redirectLoading || redirectResult === undefined) {
      return;
    }

    if (redirectResult?.found && redirectResult?.target_url) {
      if (redirectResult.target_url.startsWith('http://') || redirectResult.target_url.startsWith('https://')) {
        window.location.href = redirectResult.target_url;
      } else {
        navigate(redirectResult.target_url, { replace: true });
      }
    }
  }, [redirectResult, redirectLoading, navigate]);

  if (redirectLoading || (redirectResult === undefined)) {
    return (
      <div className="min-h-screen" data-testid="page-checking-redirect" aria-busy="true">
        <div className="sr-only">Checking page...</div>
      </div>
    );
  }

  if (redirectResult?.found && redirectResult?.target_url) {
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
