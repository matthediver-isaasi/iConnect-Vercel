import { createContext, useContext, useState, useEffect } from 'react';
import { publicClient } from '@/api/publicClient';

const TenantBrandingContext = createContext(null);

export function useTenantBranding() {
  return useContext(TenantBrandingContext);
}

// Task #3387: *.iconn.app / *.{env}.iconn.app is wildcard DNS, so a typo'd
// subdomain (fgi.dev.iconn.app for the gfi tenant) quietly serves the app for
// logged-in users. When the hostname looks like a tenant subdomain but the
// tenant lookup 404s, redirect an authenticated user to their real tenant's
// canonical host (preserving the path); guests get an explicit unknown-site
// message instead of a half-working app.
const ICONN_ENV_LABELS = ['dev', 'testing', 'preview', 'staging'];

export function parseIconnTenantHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host.endsWith('.iconn.app')) return null;
  const labels = host.slice(0, -'.iconn.app'.length).split('.').filter(Boolean);
  const nonTenant = ['www', 'api', 'app', 'admin', 'iconn'];
  if (labels.length === 1) {
    if (ICONN_ENV_LABELS.includes(labels[0]) || nonTenant.includes(labels[0])) return null;
    return { slug: labels[0], envLabel: null };
  }
  if (labels.length === 2 && ICONN_ENV_LABELS.includes(labels[1]) && !nonTenant.includes(labels[0])) {
    return { slug: labels[0], envLabel: labels[1] };
  }
  return null;
}

// Accepts only a bare DNS hostname; rejects scheme/userinfo/port/path syntax
// so a malformed stored domain can never turn the redirect into an open
// redirect to an arbitrary origin.
export function sanitizeRedirectHostname(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(d)) return null;
  return d;
}

export function buildCanonicalTenantUrl({ slug, envLabel }, tenantDomain, location) {
  const suffix = envLabel ? `.${envLabel}.iconn.app` : '.iconn.app';
  const safeSlug = String(slug).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(safeSlug)) return null;
  let host = `${safeSlug}${suffix}`;
  if (!envLabel) {
    const customHost = sanitizeRedirectHostname(tenantDomain);
    if (customHost) host = customHost;
  }
  return `https://${host}${location.pathname}${location.search}${location.hash}`;
}

async function handleUnknownTenantHost(setUnknownTenant) {
  const parsed = parseIconnTenantHost(window.location.hostname);
  if (!parsed) return; // custom domain / localhost — leave existing behaviour
  try {
    const resp = await fetch('/api/auth/me', { credentials: 'include' });
    const user = resp.ok ? await resp.json() : null;
    const realSlug = user?.tenantSlug ? String(user.tenantSlug).toLowerCase() : null;
    if (realSlug && realSlug !== parsed.slug) {
      const target = buildCanonicalTenantUrl(
        { slug: realSlug, envLabel: parsed.envLabel },
        user?.tenantDomain,
        window.location
      );
      if (target) {
        console.warn('[TenantBranding] Unknown tenant subdomain — redirecting to', target);
        window.location.replace(target);
        return;
      }
    }
  } catch (err) {
    console.error('[TenantBranding] Auth lookup for unknown subdomain failed:', err);
  }
  // Guest (or the session's tenant matches this slug, meaning the tenant
  // really is missing/inactive): show the unknown-site screen.
  setUnknownTenant(true);
}

export function TenantBrandingProvider({ children }) {
  const [branding, setBranding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unknownTenant, setUnknownTenant] = useState(false);

  useEffect(() => {
    const fetchBranding = async () => {
      const slug = publicClient.getTenantSlug();

      try {
        const data = await publicClient.getTenantBranding();
        if (data.success && data.branding) {
          setBranding(data.branding);
          
          if (data.branding.faviconUrl) {
            const iconLinks = document.querySelectorAll("link[rel~='icon']");
            if (iconLinks.length > 0) {
              iconLinks.forEach((link) => {
                 link.type = 'image/png';
                 link.sizes = '192x192';
                 if (link.getAttribute('href') !== '/favicon-192.png') {
                   link.href = '/favicon-192.png';
                }
              });
            } else {
              const newLink = document.createElement('link');
              newLink.rel = 'icon';
              newLink.href = '/favicon-192.png';
              newLink.type = 'image/png';
              newLink.sizes = '192x192';
              document.head.appendChild(newLink);
            }
          }
          
          if (data.branding.name) {
            document.title = data.branding.name;
          }

        }
      } catch (err) {
        console.error('[TenantBranding] Failed to fetch branding:', err);
        setError(err);
        if (err?.status === 404) {
          // Tenant lookup failed for this hostname — likely a typo'd
          // wildcard subdomain (Task #3387).
          await handleUnknownTenantHost(setUnknownTenant);
        }
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

  if (unknownTenant) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '0.75rem' }}>Site not found</h1>
          <p style={{ color: '#555', lineHeight: 1.5 }}>
            There's no site at <strong>{window.location.hostname}</strong>.
            Please check the address for typos — the site name comes before
            the rest of the domain.
          </p>
        </div>
      </div>
    );
  }

  return (
    <TenantBrandingContext.Provider value={value}>
      {children}
    </TenantBrandingContext.Provider>
  );
}
