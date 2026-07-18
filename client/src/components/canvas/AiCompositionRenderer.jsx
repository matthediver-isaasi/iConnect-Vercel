// AI Composition in-DOM renderer (Task #2849; Phase 2 links + selection #2850).
//
// Renders a validated AI Composition document as real DOM. All generated
// styling is instance-scoped via buildAicCss (every selector prefixed with
// [data-aic="<instanceId>"]) so it can never leak into the host page. No
// generated JS ever runs — the document carries only structure, copy and
// allowlisted CSS. DOM order follows each section's readingOrder; headings
// render as real h1–h6.
//
// Phase 2:
//   - Buttons/elements carrying a link ref render as real <a> tags when the
//     ref resolves to a route (aicLinkHref — record IDs, never AI-invented
//     URLs). Unresolvable refs stay non-navigating.
//   - `selectable` turns the renderer into a click-to-select surface for the
//     editor's Edit-with-AI panel: clicks select the nearest element (or the
//     section background) instead of navigating, and the current selection
//     is outlined.
//
// `forceBreakpoint` ('tablet'|'mobile') applies the breakpoint attribute
// variants for editor preview, where the viewport itself does not change.

import React, { useMemo } from 'react';
import {
  buildAicCss,
  orderedElements,
  sanitizeAicHtml,
  headingTag,
  aicLinkHref,
  aicLinkTarget,
} from '@/lib/aiCompositionRender';
import AicFunctionalComponent from './AicFunctionalComponent';

function elClass(el) {
  return `aic-e-${String(el.id || '').replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

const SELECTED_STYLE = {
  outline: '2px solid hsl(210 90% 55%)',
  outlineOffset: '1px',
};

function selProps(el, ctx) {
  if (!ctx.selectable) return {};
  return {
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctx.onSelect?.({ type: 'element', elementId: el.id, elementType: el.type });
    },
    style: ctx.selectedId === el.id ? SELECTED_STYLE : undefined,
    'data-aic-selectable': el.id,
  };
}

function AicElement({ el, ctx }) {
  if (!el || !el.id) return null;
  const cls = elClass(el);
  const text = el.content?.text ?? '';
  const html = typeof el.content?.html === 'string' ? sanitizeAicHtml(el.content.html) : null;
  const sel = selProps(el, ctx);

  switch (el.type) {
    case 'heading': {
      const Tag = headingTag(el);
      return <Tag className={cls} data-testid={`text-aic-${el.id}`} {...sel}>{text}</Tag>;
    }
    case 'paragraph':
      return html !== null
        ? <div className={cls} data-testid={`text-aic-${el.id}`} {...sel} dangerouslySetInnerHTML={{ __html: html }} />
        : <p className={cls} data-testid={`text-aic-${el.id}`} {...sel}>{text}</p>;
    case 'button':
    case 'text_link': {
      const label = text || el.content?.label || '';
      const href = ctx.selectable ? null : aicLinkHref(el.link);
      if (href) {
        const target = aicLinkTarget(el.link);
        return (
          <a
            className={cls}
            href={href}
            {...(target ? { target, rel: 'noopener noreferrer' } : {})}
            data-testid={`button-aic-${el.id}`}
          >
            {label}
          </a>
        );
      }
      // Unresolved CTA (no navigable link yet): still a real, focusable
      // button — disabled publicly, enabled in the editor so it can be
      // selected — never a decorative span.
      return (
        <button
          type="button"
          disabled={!ctx.selectable}
          className={cls}
          data-aic-cta="unresolved"
          data-testid={`button-aic-${el.id}`}
          {...sel}
        >
          {label}
        </button>
      );
    }
    case 'statistic':
      return (
        <div className={cls} data-testid={`stat-aic-${el.id}`} {...sel}>
          <span className="aic-stat-value">{el.data?.value ?? ''}</span>
          <span className="aic-stat-label">{el.data?.label ?? ''}</span>
        </div>
      );
    case 'shape':
    case 'background':
      return <div className={cls} aria-hidden="true" {...sel} />;
    case 'image':
    case 'generated_illustration': {
      // Phase 3: focal point → object-position; crop aspect → aspect-ratio;
      // pending/failed assets render a neutral placeholder (never broken img).
      const asset = el.asset || {};
      const src = asset.url || '';
      if (!src || asset.status === 'failed' || asset.status === 'pending') {
        return (
          <div
            className={`${cls} aic-img-placeholder`}
            data-aic-img-status={asset.status || 'empty'}
            aria-hidden="true"
            {...sel}
          />
        );
      }
      const fp = asset.focalPoint;
      const cropAspect = asset.crop?.aspectRatio;
      const imgStyle = {
        ...(fp && Number.isFinite(fp.x) && Number.isFinite(fp.y)
          ? { objectFit: 'cover', objectPosition: `${fp.x}% ${fp.y}%` }
          : {}),
        ...(cropAspect ? { aspectRatio: String(cropAspect).replace(':', ' / '), objectFit: 'cover', width: '100%' } : {}),
        ...(sel.style || {}),
      };
      const img = (
        <img
          className={cls}
          src={src}
          alt={asset.altText || ''}
          loading="lazy"
          data-testid={`img-aic-${el.id}`}
          {...sel}
          style={Object.keys(imgStyle).length ? imgStyle : undefined}
        />
      );
      // Simplified mobile variant (spec §20): swap the source on small screens.
      if (asset.mobile?.url) {
        return (
          <picture>
            <source media="(max-width: 640px)" srcSet={asset.mobile.url} />
            {img}
          </picture>
        );
      }
      return img;
    }
    case 'label':
      return <span className={cls} data-testid={`text-aic-${el.id}`} {...sel}>{text || el.content?.label || ''}</span>;
    case 'caption':
      return <figcaption className={cls} data-testid={`text-aic-${el.id}`} {...sel}>{text}</figcaption>;
    case 'timeline_item':
    case 'process_step':
      // Factual-text rule (spec §19): values/labels are ALWAYS real HTML text.
      return (
        <div className={cls} data-testid={`step-aic-${el.id}`} {...sel}>
          {el.data?.marker != null && <span className="aic-step-marker">{el.data.marker}</span>}
          <span className="aic-step-title">{el.data?.title ?? text}</span>
          {el.data?.description ? <span className="aic-step-desc">{el.data.description}</span> : null}
        </div>
      );
    case 'comparison_item':
      return (
        <div className={cls} data-testid={`compare-aic-${el.id}`} {...sel}>
          <span className="aic-compare-label">{el.data?.label ?? ''}</span>
          <span className="aic-compare-value">{el.data?.value ?? ''}</span>
        </div>
      );
    case 'simple_chart': {
      // Charts are HTML text + proportional bars — numbers never rasterised.
      const items = Array.isArray(el.data?.items) ? el.data.items : [];
      const max = Math.max(1, ...items.map((it) => Math.abs(Number(it?.value)) || 0));
      return (
        <div className={cls} role="img" aria-label={el.data?.label || 'Chart'} data-testid={`chart-aic-${el.id}`} {...sel}>
          {items.map((it, i) => {
            const v = Math.abs(Number(it?.value)) || 0;
            return (
              <div className="aic-chart-row" key={`${el.id}-r${i}`}>
                <span className="aic-chart-label">{it?.label ?? ''}</span>
                <span className="aic-chart-bar" aria-hidden="true" style={{ width: `${Math.round((v / max) * 100)}%` }} />
                <span className="aic-chart-value">{it?.display ?? it?.value ?? ''}</span>
              </div>
            );
          })}
        </div>
      );
    }
    case 'canvas_component_placeholder': {
      // Phase 5 (Task #2853): the AI recommends + positions standard iConnect
      // functionality; the REAL canvas block renders here — never a recreation.
      // In selectable (editor) mode the placeholder is select-only so clicks
      // don't operate the embedded component.
      const body = (
        <AicFunctionalComponent el={el} asEditor={ctx.selectable} className={cls} />
      );
      if (!ctx.selectable) return body;
      return (
        <div
          {...sel}
          onClickCapture={(e) => {
            e.preventDefault();
            e.stopPropagation();
            ctx.onSelect?.({ type: 'element', elementId: el.id, elementType: el.type });
          }}
        >
          {body}
        </div>
      );
    }
    case 'structured_infographic':
    case 'container':
    case 'group':
    case 'card':
      return (
        <div className={cls} {...sel}>
          {(el.children || []).map((child) => <AicElement key={child.id} el={child} ctx={ctx} />)}
        </div>
      );
    default:
      // Unknown/future element types render nothing rather than breaking.
      return null;
  }
}

export default function AiCompositionRenderer({
  document: doc,
  instanceId,
  forceBreakpoint = null,
  className = '',
  selectable = false,
  selectedId = null,
  onSelect = null,
}) {
  const css = useMemo(
    () => (doc ? buildAicCss(doc, instanceId) : ''),
    [doc, instanceId],
  );
  const ctx = { selectable, selectedId, onSelect };
  if (!doc || !Array.isArray(doc.sections)) return null;
  return (
    <div
      data-aic={String(instanceId || '').replace(/[^a-zA-Z0-9_-]/g, '')}
      {...(forceBreakpoint ? { 'data-aic-bp': forceBreakpoint } : {})}
      className={className}
    >
      <style dangerouslySetInnerHTML={{ __html: css }} />
      {doc.sections.map((section) => (
        <div
          key={section.id}
          className={`aic-s-${String(section.id || '').replace(/[^a-zA-Z0-9_-]/g, '')}`}
          {...(selectable
            ? {
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect?.({ type: 'section', sectionId: section.id });
              },
              style: selectedId === section.id ? SELECTED_STYLE : undefined,
            }
            : {})}
        >
          {orderedElements(section).map((el) => <AicElement key={el.id} el={el} ctx={ctx} />)}
        </div>
      ))}
    </div>
  );
}
