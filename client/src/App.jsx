import { lazy, Suspense, useEffect } from 'react'
import './App.css'
import Pages from "@/pages/index.jsx"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "@/components/ui/sonner"
import CookieConsent from "@/components/CookieConsent"
import { TenantBrandingProvider } from "@/contexts/TenantBrandingContext"
import SubdomainRedirect from "@/components/SubdomainRedirect"
import StaleTenantOverlay from "@/components/StaleTenantOverlay"

const SharedCustomObjectReport = lazy(() => import("@/pages/SharedCustomObjectReport.jsx"))

function PortalApplication() {
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
      <StaleTenantOverlay />
    </TenantBrandingProvider>
  )
}

function SharedReportApplication() {
  return (
    <BrowserRouter>
      <Suspense fallback={<main className="min-h-[100dvh] bg-[#eef4f2] p-8" aria-label="Loading shared report">
        <div className="mx-auto max-w-6xl animate-pulse space-y-4">
          <div className="h-10 w-56 rounded-lg bg-teal-900/10" />
          <div className="h-48 rounded-2xl bg-white/80" />
        </div>
      </main>}>
        <Routes>
          <Route path="/shared-reports/:token" element={<SharedCustomObjectReport />} />
          <Route path="*" element={<main className="min-h-[100dvh] bg-[#eef4f2]" />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

function App() {
  const isSharedReport = typeof window !== "undefined"
    && window.location.pathname.toLowerCase().startsWith("/shared-reports/")

  // Capability links use a deliberately isolated router tree: no tenant
  // branding, CRM layout, auth bootstrap, cookie consent, or tracking mounts.
  if (isSharedReport) return <SharedReportApplication />
  return <PortalApplication />
}

export default App 