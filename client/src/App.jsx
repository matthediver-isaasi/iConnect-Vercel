import './App.css'
import Pages from "@/pages/index.jsx"
import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "@/components/ui/sonner"
import CookieConsent from "@/components/CookieConsent"
import { TenantBrandingProvider } from "@/contexts/TenantBrandingContext"

function App() {
  return (
    <TenantBrandingProvider>
      <Pages />
      <Toaster />
      <SonnerToaster position="top-right" richColors />
      <CookieConsent />
    </TenantBrandingProvider>
  )
}

export default App 