// AI Composition in-DOM renderer (Task #2849).
//
// Renders a validated AI Composition document as real DOM. All generated
// styling is instance-scoped via buildAicCss (every selector prefixed with
// [data-aic="<instanceId>"]) so it can never leak into the host page. No
// generated JS ever runs — the document carries only structure, copy and
// allowlisted CSS. DOM order follows each section's readingOrder; headings
// render as real h1–h6.
//
// `forceBreakpoint` ('tablet'|'mobile') applies the breakpoint attribute
// variants for editor preview, where the viewport itself does not change.

import { useMemo } from 'react';
import {
  buildAicCss,
  orderedElements,
  sanitizeAicStyle,
  sanitizeAicHtml,
  headingTag,
} from '@/lib/aiCompositionRender';

function elClass(el) {
  return `aic-e-${String(el.id || '').replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function AicElement({ el }) {
  if (!el || !el.id) return null;
  const cls = elClass(el);
  const text = el.content?.text ?? '';
  const html = typeof el.content?.html === 'string' ? sanitizeAicHtml(el.content.html) : null;

  switch (el.type) {
    case 'heading': {
      const Tag = headingTag(el);
      return <Tag className={cls} data-testid={`text-aic-${el.id}`}>{text}</Tag>;
    }
    case 'paragraph':
      return html !== null
        ? <div className={cls} data-testid={`text-aic-${el.id}`} dangerouslySetInnerHTML={{ __html: html }} />
        : <p className={cls} data-testid={`text-aic-${el.id}`}>{text}</p>;
    case 'button':
      // Phase 1: no links in generated documents — render a non-navigating
      // visual button (Phase 2 wires LinkField-resolved targets).
      return (
        <span role="presentation" className={cls} data-testid={`button-aic-${el.id}`}>
          {text || el.content?.label || ''}
        </span>
      );
    case 'statistic':
      return (
        <div className={cls} data-testid={`stat-aic-${el.id}`}>
          <span className="aic-stat-value">{el.data?.value ?? ''}</span>
          <span className="aic-stat-label">{el.data?.label ?? ''}</span>
        </div>
      );
    case 'shape':
    case 'background':
      return <div className={cls} aria-hidden="true" />;
    case 'image': {
      const src = el.asset?.url || '';
      if (!src) return <div className={cls} aria-hidden="true" />;
      return <img className={cls} src={src} alt={el.asset?.altText || ''} loading="lazy" />;
    }
    case 'container':
    case 'group':
    case 'card':
      return (
        <div className={cls}>
          {(el.children || []).map((child) => <AicElement key={child.id} el={child} />)}
        </div>
      );
    default:
      // Unknown/future element types render nothing rather than breaking.
      return null;
  }
}

export default function AiCompositionRenderer({ document: doc, instanceId, forceBreakpoint = null, className = '' }) {
  const css = useMemo(
    () => (doc ? buildAicCss(doc, instanceId) : ''),
    [doc, instanceId],
  );
  if (!doc || !Array.isArray(doc.sections)) return null;
  return (
    <div
      data-aic={String(instanceId || '').replace(/[^a-zA-Z0-9_-]/g, '')}
      {...(forceBreakpoint ? { 'data-aic-bp': forceBreakpoint } : {})}
      className={className}
    >
      <style dangerouslySetInnerHTML={{ __html: css }} />
      {doc.sections.map((section) => (
        <div key={section.id} className={`aic-s-${String(section.id || '').replace(/[^a-zA-Z0-9_-]/g, '')}`}>
          {orderedElements(section).map((el) => <AicElement key={el.id} el={el} />)}
        </div>
      ))}
    </div>
  );
}
