import { createContext, useCallback, useContext } from 'react';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { resolveCanvasMemberHtml } from '@shared/canvasMemberTokens.js';
import { sanitizeRichText, stripTrailingEmptyParagraphs } from './blocks/sanitize';

// Symbol child previews deliberately use public renderers to avoid recursive
// symbol expansion. Carry template mode independently of their interaction mode.
export const CanvasRichTextTemplateContext = createContext(false);

// Resolve only at the rich-text display boundary, never in a design object.
// Authoring stages keep the template; public renderers (including embedded
// previews, symbols and footers) use the current validated viewer.
export function useCanvasRichText(asEditor = false) {
  const inheritedTemplateMode = useContext(CanvasRichTextTemplateContext);
  const { canvasMemberValues, sessionValidated, authResolved } = useLayoutContext();
  const values = sessionValidated && authResolved ? canvasMemberValues : undefined;
  return useCallback((html, { trim = true } = {}) => {
    const safe = sanitizeRichText(trim ? stripTrailingEmptyParagraphs(html || '') : (html || ''));
    return asEditor || inheritedTemplateMode ? safe : resolveCanvasMemberHtml(safe, values);
  }, [asEditor, inheritedTemplateMode, values]);
}