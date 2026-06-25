import { createRoot } from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
// Font Awesome Free (solid/regular/brands) — loaded app-wide so its CSS and
// web fonts are available in both the CanvasBuilder editor and the
// public/SSR-rendered canvas pages (used for custom bullet-list icons).
import '@fortawesome/fontawesome-free/css/all.min.css'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

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
