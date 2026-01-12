import { createContext, useContext, useState, useEffect } from 'react';

const TenantBrandingContext = createContext(null);

export function useTenantBranding() {
  return useContext(TenantBrandingContext);
}

function getTenantSlugFromHostname() {
  const hostname = window.location.hostname;
  
  if (hostname.endsWith('.iconn.app')) {
    const slug = hostname.replace('.iconn.app', '');
    if (slug && slug !== 'www' && slug !== 'app') {
      return slug;
    }
  }
  
  if (hostname === 'localhost' || hostname.includes('replit')) {
    const stored = localStorage.getItem('dev_tenant_slug');
    if (stored) return stored;
  }
  
  return null;
}

export function TenantBrandingProvider({ children }) {
  const [branding, setBranding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchBranding = async () => {
      const slug = getTenantSlugFromHostname();
      
      if (!slug) {
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/public/tenant-branding?slug=${slug}`);
        if (response.ok) {
          const data = await response.json();
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

  const value = {
    branding,
    loading,
    error,
    tenantSlug: getTenantSlugFromHostname(),
    hasBranding: !!branding
  };

  return (
    <TenantBrandingContext.Provider value={value}>
      {children}
    </TenantBrandingContext.Provider>
  );
}
