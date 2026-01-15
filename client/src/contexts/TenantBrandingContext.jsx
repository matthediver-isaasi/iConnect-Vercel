import { createContext, useContext, useState, useEffect } from 'react';
import { publicClient } from '@/api/publicClient';

const TenantBrandingContext = createContext(null);

export function useTenantBranding() {
  return useContext(TenantBrandingContext);
}

export function TenantBrandingProvider({ children }) {
  const [branding, setBranding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchBranding = async () => {
      // Get tenant slug from publicClient's detection logic
      const slug = publicClient.getTenantSlug();
      
      if (!slug) {
        setLoading(false);
        return;
      }

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
    tenantSlug: publicClient.getTenantSlug(),
    hasBranding: !!branding
  };

  return (
    <TenantBrandingContext.Provider value={value}>
      {children}
    </TenantBrandingContext.Provider>
  );
}
