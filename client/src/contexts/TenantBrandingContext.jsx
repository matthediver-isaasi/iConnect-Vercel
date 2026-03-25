import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { publicClient } from '@/api/publicClient';

const TenantBrandingContext = createContext(null);

export function useTenantBranding() {
  return useContext(TenantBrandingContext);
}

function injectGA4(measurementId) {
  if (!measurementId || !/^G-[A-Z0-9]{4,20}$/.test(measurementId)) {
    return;
  }
  if (document.querySelector('script[data-ga4-injected]')) {
    return;
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  script.setAttribute('data-ga4-injected', 'true');
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', measurementId, { send_page_view: true });
}

export function TenantBrandingProvider({ children }) {
  const [branding, setBranding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const ga4Injected = useRef(false);

  useEffect(() => {
    const fetchBranding = async () => {
      const slug = publicClient.getTenantSlug();

      try {
        const data = await publicClient.getTenantBranding();
        if (data.success && data.branding) {
          setBranding(data.branding);
          
          if (data.branding.faviconUrl) {
            const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
            link.type = 'image/x-icon';
            link.rel = 'shortcut icon';
            link.href = data.branding.faviconUrl;
            document.getElementsByTagName('head')[0].appendChild(link);
          }
          
          if (data.branding.name) {
            document.title = data.branding.name;
          }

          if (data.branding.ga4MeasurementId && !ga4Injected.current) {
            injectGA4(data.branding.ga4MeasurementId);
            ga4Injected.current = true;
          }
        }
      } catch (err) {
        console.error('[TenantBranding] Failed to fetch branding:', err);
        setError(err);
      } finally {
        setLoading(false);
      }
    };

    fetchBranding();
  }, []);

  useEffect(() => {
    if (!branding?.ga4MeasurementId) return;

    let lastPath = window.location.pathname + window.location.search;

    const trackRouteChange = () => {
      const currentPath = window.location.pathname + window.location.search;
      if (currentPath !== lastPath) {
        lastPath = currentPath;
        if (typeof window.gtag === 'function') {
          window.gtag('event', 'page_view', {
            page_path: currentPath,
            page_title: document.title
          });
        }
      }
    };

    window.addEventListener('popstate', trackRouteChange);

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      trackRouteChange();
    };
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      trackRouteChange();
    };

    return () => {
      window.removeEventListener('popstate', trackRouteChange);
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    };
  }, [branding?.ga4MeasurementId]);

  const value = {
    branding,
    loading,
    error,
    tenantSlug: publicClient.getTenantSlug(),
    hasBranding: !!branding
  };

  return (
    <TenantBrandingContext.Provider value={value}>
      {children}
    </TenantBrandingContext.Provider>
  );
}
