import { useEffect } from 'react'
import './App.css'
import Pages from "@/pages/index.jsx"
import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "@/components/ui/sonner"
import CookieConsent from "@/components/CookieConsent"
import { TenantBrandingProvider } from "@/contexts/TenantBrandingContext"
import SubdomainRedirect from "@/components/SubdomainRedirect"
import StaleTenantOverlay from "@/components/StaleTenantOverlay"
import { Analytics } from '@vercel/analytics/react'

function App() {
  // Ensure <html lang> is always set for assistive tech. Per-tenant locale
  // overrides can update this later; default to English.
  useEffect(() => {
    if (typeof document !== 'undefined' && !document.documentElement.getAttribute('lang')) {
      document.documentElement.setAttribute('lang', 'en')
    }
  }, [])

  // Global tenant-intent bootstrap.
  // Fires once on app mount so that _activeTenantId is always initialised,
  // even for admin pages (AdminTeam, PlanUsage, OnboardingWizard, etc.) that
  // do NOT call /api/auth/tenant-user-me themselves.
  // The global fetch interceptor (fetchInterceptor.js) listens for this
  // response and calls setActiveTenantId(tenant.id) automatically.
  // This fire-and-forget call is safe for portal/unauthenticated contexts:
  // - Unauthenticated → returns { authenticated: false } → interceptor no-ops
  // - Member session → no tenant.id → interceptor no-ops
  // - Tenant admin → interceptor sets _activeTenantId so all subsequent
  //   /api/* mutations carry the correct X-Tenant-Id header
  useEffect(() => {
    fetch('/api/auth/tenant-user-me', { credentials: 'include' }).catch(() => {})
  }, [])

  // Dev-only axe-core integration. Lazy-loaded so it never ships to prod.
  // Falls back silently if @axe-core/react is not installed yet.
  useEffect(() => {
    if (import.meta.env.DEV) {
      const axePkg = '@axe-core/react'
      Promise.all([
        import('react'),
        import('react-dom'),
        import(/* @vite-ignore */ axePkg),
      ])
        .then(([React, ReactDOM, axe]) => {
          axe.default(React.default || React, ReactDOM.default || ReactDOM, 1000)
        })
        .catch(() => {
          // @axe-core/react not installed; skip silently.
        })
    }
  }, [])

  return (
    <TenantBrandingProvider>
      <SubdomainRedirect />
      <Pages />
      <Toaster />
      <SonnerToaster position="top-right" richColors />
      <CookieConsent />
      <Analytics />
      <StaleTenantOverlay />
    </TenantBrandingProvider>
  )
}

export default App 