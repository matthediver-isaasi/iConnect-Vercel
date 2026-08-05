import { createRoot } from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
// Font Awesome Free (solid/regular/brands) — loaded app-wide so its CSS and
// web fonts are available in both the CanvasBuilder editor and the
// public/SSR-rendered canvas pages (used for custom bullet-list icons).
import '@fortawesome/fontawesome-free/css/all.min.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { installFetchInterceptor } from '@/lib/fetchInterceptor'
import { installRefocusCheck } from '@/lib/refocusCheck'
import { installStaleChunkReload } from '@/lib/staleChunkReload'

// Install global fetch interceptor immediately so every /api/ request with
// credentials automatically carries X-Tenant-Id and handles 409 TENANT_CONTEXT_CHANGED.
installFetchInterceptor()

// Install proactive stale-tab detection: checks session tenant on refocus
// before any API call is made, so the lock overlay appears immediately.
installRefocusCheck()

// Install app-wide stale-chunk recovery: after a deploy, dynamic imports of
// old content-hashed chunks reject; reload once (loop-guarded) to pick up the
// fresh build instead of stranding the user on a broken lazy component.
installStaleChunkReload()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000, // 5 seconds - data considered fresh for 5 seconds
      refetchOnMount: true, // Always check for fresh data when returning to a page
      refetchOnWindowFocus: false, // Don't refetch when window regains focus (too aggressive)
      retry: false, // Disable retries to prevent long delays on failed requests
    },
  },
})

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
)
