import { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

// Task #1602 — live symbol previews in the Canvas editor.
//
// The editor's symbol block renderer needs the referenced symbols' full
// design documents so it can draw their real content on the stage instead
// of a grey placeholder. Rather than refetch per instance, the editor shell
// publishes the tenant's symbols once via this context and the symbol block
// reads them with `useCanvasSymbols()`.
//
// This mirrors how the PUBLIC renderer (CanvasPageRenderer) fetches symbols,
// but uses the AUTHENTICATED endpoint (`/api/canvas-symbols?full=1`) since
// the editor runs in an authenticated admin context. Resolution stays a
// read-time transform — the persisted page design never gains the resolved
// children.
//
// Default is `null` so consumers used outside the editor (e.g. the public
// renderer, which never mounts this provider) never crash; they simply skip
// the live preview.
const CanvasSymbolsContext = createContext(null);

export function CanvasSymbolsProvider({ children }) {
  const { data, status } = useQuery({
    queryKey: ['canvas-symbols', 'full'],
    queryFn: async () => {
      const r = await fetch('/api/canvas-symbols?full=1', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load symbols');
      return r.json();
    },
    staleTime: 30_000,
  });

  const value = useMemo(() => {
    const map = new Map();
    for (const s of data?.symbols || []) map.set(s.id, s);
    return {
      symbolsById: map,
      // `loaded` is true once the fetch has settled (success or error) so the
      // renderer can distinguish "still loading" from "id genuinely missing".
      loaded: status === 'success' || status === 'error',
    };
  }, [data, status]);

  return (
    <CanvasSymbolsContext.Provider value={value}>
      {children}
    </CanvasSymbolsContext.Provider>
  );
}

export function useCanvasSymbols() {
  return useContext(CanvasSymbolsContext);
}
