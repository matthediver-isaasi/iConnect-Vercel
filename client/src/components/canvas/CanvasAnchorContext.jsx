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
// Task #1448: cross-page anchor links. In addition to the *current* page's
// anchors, the editor also publishes the anchors of every OTHER canvas page
// (`pages`) so a link field can target a section on another page, producing
// a `/page-slug#anchor-id` href. Same-page links keep the bare `#anchor-id`
// form.
//
// Default is an empty list so consumers used outside the editor (e.g. the
// public renderer, which never mounts Inspector components) never crash.
const CanvasAnchorContext = createContext({
  anchors: [],
  duplicateAnchorIds: new Set(),
  pages: [],
});

export function CanvasAnchorProvider({ design, pages, children }) {
  const value = useMemo(() => {
    // Resolve the anchors of every other canvas page once. Each entry is
    // `{ id, slug, title, anchors }` where `anchors` reuses the same shape
    // as the current page's list. Pages without a slug or without any
    // anchors are dropped — there is nothing to link to.
    const otherPages = (Array.isArray(pages) ? pages : [])
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title || p.slug,
        anchors: getPageAnchors(p.design).filter((a) => a.anchorId),
      }))
      .filter((p) => p.slug && p.anchors.length > 0);
    return {
      anchors: getPageAnchors(design),
      duplicateAnchorIds: findDuplicateAnchorIds(design),
      pages: otherPages,
    };
  }, [design, pages]);
  return (
    <CanvasAnchorContext.Provider value={value}>
      {children}
    </CanvasAnchorContext.Provider>
  );
}

export function useCanvasAnchors() {
  return useContext(CanvasAnchorContext);
}
