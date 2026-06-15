import { createContext, useContext, useMemo } from 'react';
import { getPageAnchors, findDuplicateAnchorIds } from '@/lib/canvasDesign';

// Task #1446: in-page anchor links.
//
// The block link-field editors (button/hero/card/pricing CTAs, image link,
// mega-menu links, in-page text links) live deep inside the registry's
// per-block Inspector components, which only receive `block` / `update`.
// Rather than thread the page-wide anchor list through every one of them,
// the editor shell publishes it once via this context and each link field
// reads it with `useCanvasAnchors()`.
//
// Default is an empty list so consumers used outside the editor (e.g. the
// public renderer, which never mounts Inspector components) never crash.
const CanvasAnchorContext = createContext({
  anchors: [],
  duplicateAnchorIds: new Set(),
});

export function CanvasAnchorProvider({ design, children }) {
  const value = useMemo(() => ({
    anchors: getPageAnchors(design),
    duplicateAnchorIds: findDuplicateAnchorIds(design),
  }), [design]);
  return (
    <CanvasAnchorContext.Provider value={value}>
      {children}
    </CanvasAnchorContext.Provider>
  );
}

export function useCanvasAnchors() {
  return useContext(CanvasAnchorContext);
}
