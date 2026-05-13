import { useEffect } from 'react'
import './App.css'
import Pages from "@/pages/index.jsx"
import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "@/components/ui/sonner"
import CookieConsent from "@/components/CookieConsent"
import { TenantBrandingProvider } from "@/contexts/TenantBrandingContext"
import SubdomainRedirect from "@/components/SubdomainRedirect"

function App() {
  // Ensure <html lang> is always set for assistive tech. Per-tenant locale
  // overrides can update this later; default to English.
  useEffect(() => {
    if (typeof document !== 'undefined' && !document.documentElement.getAttribute('lang')) {
      document.documentElement.setAttribute('lang', 'en')
    }
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
    </TenantBrandingProvider>
  )
}

export default App 