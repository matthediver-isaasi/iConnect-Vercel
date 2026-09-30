// Phase 5 (Task #2853): renders a canvas_component_placeholder as the REAL
// iConnect canvas block (form embed, event teaser, listings, login, …).
//
// The block registry is loaded lazily: registry.jsx → dynamicBlocks.jsx →
// AiCompositionBlock.jsx → AiCompositionRenderer.jsx already forms an import
// chain, so a static import here would be circular. Lazy loading breaks the
// cycle and costs nothing on pages without placeholders.

import { lazy, Suspense, useMemo } from 'react';
import { resolveFunctionalComponent, functionalComponentLabel } from '@/lib/aicFunctionalComponents';

const noticeStyle = {
  border: '1px dashed #cbd5e1',
  borderRadius: 6,
  padding: '16px',
  fontSize: 13,
  color: '#64748b',
  background: '#f8fafc',
  textAlign: 'center',
};

function makeLazyRenderer(blockType, asEditor) {
  return lazy(() => import('./blocks/registry').then((m) => {
    const def = m.getBlockDefinition(blockType);
    const Comp = (asEditor ? def?.Editor : def?.Renderer) || null;
    return { default: Comp || (() => null) };
  }));
}

export default function AicFunctionalComponent({ el, asEditor = false, className = '' }) {
  const data = el?.data || {};
  const resolved = useMemo(
    () => resolveFunctionalComponent(data, el?.id),
    [data, el?.id],
  );
  const Renderer = useMemo(
    () => (resolved ? makeLazyRenderer(resolved.blockType, asEditor) : null),
    [resolved?.blockType, asEditor],
  );

  const label = functionalComponentLabel(data);

  if (!resolved || !Renderer) {
    // No canvas block for this key (or a required record is missing): show a
    // neutral notice in the editor, nothing on the public page. We never fake
    // the functionality.
    if (!asEditor) return null;
    return (
      <div className={className} style={noticeStyle} data-testid={`aic-component-unwired-${el?.id}`}>
        Recommended iConnect component: <strong>{label}</strong>
        <div style={{ marginTop: 4, fontSize: 12 }}>
          Not wired to a record yet — pick the record in the brief or add the standard block manually.
        </div>
      </div>
    );
  }

  return (
    <div className={className} data-testid={`aic-component-${el?.id}`} data-aic-component={resolved.componentKey}>
      <Suspense fallback={<div style={noticeStyle}>Loading {label}…</div>}>
        <Renderer block={resolved.block} asEditor={asEditor} />
      </Suspense>
    </div>
  );
}
