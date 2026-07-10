import { createContext, useContext, useMemo } from 'react';

/**
 * Task #2550: exposes metadata about the page currently open in the Canvas
 * Builder editor to block inspectors. The editor stage is never mounted on a
 * public microsite route, so `useMicrosite()` returns null there — block
 * inspectors that need to know whether the page belongs to a microsite (e.g.
 * the Search Input block's "Include results from outside this microsite"
 * toggle) read it from here instead.
 *
 * On the public page this provider is absent, so `useCanvasEditorPage()`
 * degrades to "no editor context" — safe because only inspectors consume it.
 */
const CanvasEditorPageContext = createContext(null);

export function useCanvasEditorPage() {
  return useContext(CanvasEditorPageContext) || { micrositeId: null, isMicrositePage: false };
}

export function CanvasEditorPageProvider({ micrositeId = null, children }) {
  const value = useMemo(
    () => ({ micrositeId: micrositeId || null, isMicrositePage: !!micrositeId }),
    [micrositeId],
  );
  return (
    <CanvasEditorPageContext.Provider value={value}>
      {children}
    </CanvasEditorPageContext.Provider>
  );
}
