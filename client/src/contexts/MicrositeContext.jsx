import { createContext, useContext, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';
import { useTenantBranding } from '@/contexts/TenantBrandingContext';

/**
 * Task #2426: microsite context.
 *
 * Detects whether the current URL lives under an active microsite prefix
 * (/{prefix}/{slug}) and, when it does, exposes the microsite plus its
 * merged branding (header/footer/logo overrides from the microsite over the
 * tenant defaults). The default site — every URL whose first segment is not
 * an active microsite prefix — is completely unaffected: `activeMicrosite`
 * stays null and consumers fall through to normal tenant branding/nav.
 */

const MicrositeContext = createContext(null);

/**
 * Task #2533: the SSR layer injects the resolved microsite chrome (active
 * microsite + merged branding) as window.__MICROSITE_CONTEXT__ on microsite
 * routes so the correct header/footer paints on first load. Read it once so we
 * can seed the context synchronously; absent (default site / tenant-less host)
 * we fall back to the client-fetch path with no change.
 */
function readInjectedMicrositeContext() {
  if (typeof window === 'undefined') return null;
  const g = window.__MICROSITE_CONTEXT__;
  if (g && typeof g === 'object' && g.activeMicrosite?.path_prefix && g.branding) {
    return g;
  }
  return null;
}

export function useMicrosite() {
  return useContext(MicrositeContext) || {
    microsites: [],
    micrositesLoaded: false,
    activeMicrosite: null,
    micrositePrefix: null,
    micrositeBranding: null,
    micrositeBrandingLoading: false,
  };
}

/**
 * Chrome components (PublicHeader / PublicLayout) call this instead of
 * useTenantBranding directly: on microsite routes it returns the merged
 * microsite branding once loaded, elsewhere the tenant branding unchanged.
 */
export function usePublicChromeBranding() {
  const tenantCtx = useTenantBranding() || {};
  const { activeMicrosite, micrositeBranding, micrositeBrandingLoading } = useMicrosite();
  if (activeMicrosite && micrositeBranding) {
    return { ...tenantCtx, branding: micrositeBranding };
  }
  // While the microsite branding is in flight, keep the tenant branding so
  // the header doesn't flash empty; it swaps once the merged config lands.
  return tenantCtx;
}

export function MicrositeProvider({ children }) {
  const location = useLocation();
  // Read once per mount — the SSR-injected global doesn't change at runtime.
  const injected = useMemo(() => readInjectedMicrositeContext(), []);

  const { data: micrositesData, isFetched: micrositesLoaded } = useQuery({
    queryKey: ['public-microsites'],
    queryFn: async () => {
      try {
        const res = await publicClient.listMicrosites();
        return res?.microsites || [];
      } catch {
        // No microsites (or legacy backend) — default site behaviour.
        return [];
      }
    },
    staleTime: 5 * 60 * 1000,
  });
  const microsites = micrositesData || [];

  // First path segment, lowercased. Only ever matches when the tenant has an
  // active microsite with that exact prefix — reserved app routes can never
  // be prefixes (validated server-side on create).
  const firstSegment = useMemo(() => {
    const seg = (location.pathname || '/').split('/').filter(Boolean)[0] || '';
    return seg.toLowerCase();
  }, [location.pathname]);

  const activeMicrosite = useMemo(() => {
    if (!firstSegment) return null;
    // Prefer the freshly fetched list row once available.
    const fromList = microsites.find((m) => m.path_prefix === firstSegment) || null;
    if (fromList) return fromList;
    // First paint on a microsite route: seed from the SSR-injected global so
    // the chrome resolves synchronously before the microsites list loads.
    if (injected?.activeMicrosite?.path_prefix === firstSegment) {
      return injected.activeMicrosite;
    }
    return null;
  }, [firstSegment, microsites, injected]);

  const micrositePrefix = activeMicrosite?.path_prefix || null;

  // Seed the branding query from the injected global when it's for this route,
  // so usePublicChromeBranding returns microsite branding on the very first
  // paint. initialDataUpdatedAt: 0 keeps it "stale" so the client still
  // refetches in the background (refresh/fallback path unchanged).
  const injectedBrandingForRoute = (injected?.activeMicrosite?.path_prefix === micrositePrefix)
    ? injected.branding
    : undefined;

  const { data: micrositeBrandingData, isLoading: micrositeBrandingLoading } = useQuery({
    queryKey: ['public-microsite-branding', micrositePrefix],
    queryFn: async () => {
      const res = await publicClient.getTenantBranding(micrositePrefix);
      return (res?.success && res.branding) ? res.branding : null;
    },
    enabled: !!micrositePrefix,
    staleTime: 5 * 60 * 1000,
    initialData: injectedBrandingForRoute,
    initialDataUpdatedAt: injectedBrandingForRoute ? 0 : undefined,
  });

  const value = useMemo(() => ({
    microsites,
    micrositesLoaded: !!micrositesLoaded,
    activeMicrosite,
    micrositePrefix,
    micrositeBranding: activeMicrosite ? (micrositeBrandingData || null) : null,
    micrositeBrandingLoading: !!micrositePrefix && micrositeBrandingLoading,
  }), [microsites, micrositesLoaded, activeMicrosite, micrositePrefix, micrositeBrandingData, micrositeBrandingLoading]);

  return (
    <MicrositeContext.Provider value={value}>
      {children}
    </MicrositeContext.Provider>
  );
}
