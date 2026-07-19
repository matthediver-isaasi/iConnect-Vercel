// AI Design Studio V2 — Phase 3 deterministic layout inspection (Task #2907).
//
// Two halves:
//   1. LAYOUT_METRICS_RUNNER_CODE — a Browserless `/function` script that
//      renders the signed CSP-locked preview URL at one viewport and returns
//      raw browser-computed geometry (rects, font sizes, overflow, media
//      state). It measures — it never judges.
//   2. inspectCodeLayout(...) — pure Node logic that turns those metrics into
//      explicit layout issues (zero-size, severe overlaps, horizontal scroll,
//      clipped headings, off-canvas buttons, empty sections, missing CTA
//      actions, tiny text, broken media, collapsed parents, excessive width).
//
// Keeping judgement out of the browser keeps every threshold unit-testable
// with fabricated metrics — no network in tests.

// ---------------------------------------------------------------------------
// In-page metrics collector (runs inside Browserless /function)
// ---------------------------------------------------------------------------

export const LAYOUT_METRICS_RUNNER_CODE = `
export default async function ({ page, context }) {
  const { url, width, height, navigationTimeout } = context;
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: navigationTimeout });
  } catch (err) {
    return { data: { error: 'navigation_failed', message: String(err && err.message || err) }, type: 'application/json' };
  }
  try { await page.evaluate(() => (document.fonts && document.fonts.ready) || null); } catch {}
  try {
    const metrics = await page.evaluate(() => {
      const wrapper = document.querySelector('[data-ai-composition]');
      const doc = document.documentElement;
      const vw = window.innerWidth;
      const collect = [];
      const nodes = wrapper ? wrapper.querySelectorAll('*') : [];
      let idx = 0;
      const idOf = (el) => el.getAttribute('data-ai-id') || null;
      for (const el of nodes) {
        idx += 1;
        const tag = el.tagName.toLowerCase();
        const aiId = idOf(el);
        const action = el.getAttribute('data-ai-action') || null;
        const slot = el.getAttribute('data-iconnect-slot') || null;
        const isHeading = /^h[1-6]$/.test(tag);
        const isInteractive = tag === 'a' || tag === 'button' || !!action;
        const isText = tag === 'p' || tag === 'li' || isHeading;
        if (!aiId && !action && !slot && tag !== 'section' && tag !== 'svg' && tag !== 'img' && !isText && !isInteractive) continue;
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        const ancestors = [];
        let p = el.parentElement;
        while (p && p !== wrapper) { const pid = idOf(p); if (pid) ancestors.push(pid); p = p.parentElement; }
        const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        collect.push({
          key: aiId || (tag + '#' + idx),
          aiId, tag, action, slot, isHeading, isInteractive,
          rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
          fontSize: parseFloat(cs.fontSize) || 0,
          display: cs.display,
          visibility: cs.visibility,
          overflowX: Math.max(0, el.scrollWidth - el.clientWidth),
          textLength: text.length,
          ancestors,
          broken: tag === 'img' ? !(el.complete && el.naturalWidth > 0) : false,
          childElementCount: el.childElementCount,
        });
      }
      const sections = [];
      const tops = wrapper ? wrapper.querySelectorAll(':scope > section, :scope > * > section') : [];
      for (const s of tops) {
        const r = s.getBoundingClientRect();
        let maxChildH = 0;
        for (const c of s.children) { const cr = c.getBoundingClientRect(); if (cr.height > maxChildH) maxChildH = cr.height; }
        sections.push({
          aiId: s.getAttribute('data-ai-id') || null,
          rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height },
          textLength: ((s.innerText || '').replace(/\\s+/g, ' ').trim()).length,
          childCount: s.childElementCount,
          maxChildHeight: maxChildH,
          hasSlot: !!s.querySelector('[data-iconnect-slot]'),
          hasSvg: !!s.querySelector('svg'),
        });
      }
      return {
        viewport: { width: vw, height: window.innerHeight },
        document: { scrollWidth: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0), clientWidth: doc.clientWidth },
        wrapper: wrapper ? { height: wrapper.getBoundingClientRect().height } : null,
        elements: collect,
        sections,
      };
    });
    return { data: metrics, type: 'application/json' };
  } catch (err) {
    return { data: { error: 'metrics_failed', message: String(err && err.message || err) }, type: 'application/json' };
  }
}
`;

// ---------------------------------------------------------------------------
// Pure inspection
// ---------------------------------------------------------------------------

const MIN_FONT_PX = 11;
const OVERLAP_RATIO = 0.6;     // >60% of the smaller box covered = severe
const EXCESS_WIDTH_RATIO = 1.05;
const EMPTY_SECTION_MIN_HEIGHT = 40;
const COLLAPSED_PARENT_RATIO = 0.5;

const isVisible = (e) => e.display !== 'none' && e.visibility !== 'hidden'
  && e.rect && e.rect.w > 0 && e.rect.h > 0;

function overlapArea(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

/**
 * Inspect one breakpoint's metrics. Returns issues:
 *   { code, message, breakpoint, elementId?, severity: 'blocking'|'advisory' }
 */
export function inspectBreakpointMetrics(metrics, { breakpoint = 'desktop', width = 1440, document: doc = null } = {}) {
  const issues = [];
  const push = (code, message, elementId = null, severity = 'blocking') => {
    issues.push({ code, message, breakpoint, elementId, severity });
  };
  if (!metrics || typeof metrics !== 'object' || metrics.error) {
    return { ok: false, issues: [], captureError: metrics?.message || metrics?.error || 'No metrics captured' };
  }

  const vw = metrics.viewport?.width || width;
  const elements = Array.isArray(metrics.elements) ? metrics.elements : [];
  const sections = Array.isArray(metrics.sections) ? metrics.sections : [];

  // Horizontal scroll — the page must never scroll sideways.
  if ((metrics.document?.scrollWidth || 0) > vw + 1) {
    push('horizontal_scroll',
      `The page scrolls horizontally at ${vw}px (content is ${metrics.document.scrollWidth}px wide) — nothing may extend past the viewport.`);
  }

  // Wrapper collapsed entirely.
  if (metrics.wrapper && metrics.wrapper.height <= 1 && elements.some(isVisible)) {
    push('invalid_parent_height', 'The composition wrapper has collapsed to zero height while it contains visible content — a parent is not expanding around its children.');
  }

  const meaningful = elements.filter((e) => e.aiId || e.action || e.isHeading || e.isInteractive || e.textLength >= 8);

  for (const e of meaningful) {
    const r = e.rect || { x: 0, y: 0, w: 0, h: 0 };
    const label = e.aiId || e.key || e.tag;

    // Zero-size content that should be visible.
    if (e.display !== 'none' && e.visibility !== 'hidden' && (r.w === 0 || r.h === 0)
      && (e.textLength >= 4 || e.isInteractive || e.slot || e.tag === 'svg')) {
      push('zero_size', `"${label}" (${e.tag}) renders at ${Math.round(r.w)}x${Math.round(r.h)}px — it has content but no visible size.`, label);
      continue;
    }
    if (!isVisible(e)) continue;

    // Off-canvas interactive elements.
    if (e.isInteractive) {
      const offLeft = r.x + r.w <= 0;
      const offRight = r.x >= vw;
      const partiallyOff = r.x < -2 || r.x + r.w > vw + 2;
      if (offLeft || offRight) {
        push('off_canvas_button', `Interactive element "${label}" sits entirely outside the ${vw}px viewport (x=${Math.round(r.x)}).`, label);
      } else if (partiallyOff && (Math.min(0, r.x) * -1 + Math.max(0, r.x + r.w - vw)) > r.w * 0.4) {
        push('off_canvas_button', `Interactive element "${label}" is mostly cut off at the ${vw}px viewport edge.`, label);
      }
    }

    // Clipped headings (text wider than its box).
    if (e.isHeading && e.overflowX > 4) {
      push('clipped_heading', `Heading "${label}" is clipped — its text overflows its box by ${Math.round(e.overflowX)}px at ${vw}px.`, label);
    }

    // Tiny text (advisory).
    if (e.textLength >= 8 && e.fontSize > 0 && e.fontSize < MIN_FONT_PX) {
      push('tiny_text', `"${label}" uses ${e.fontSize}px text — below the ${MIN_FONT_PX}px readability floor.`, label, 'advisory');
    }

    // Excessive width.
    if (r.w > vw * EXCESS_WIDTH_RATIO) {
      push('excessive_width', `"${label}" is ${Math.round(r.w)}px wide — wider than the ${vw}px viewport.`, label);
    }

    // Broken media.
    if (e.broken) {
      push('broken_media', `Image "${label}" failed to load (zero natural size).`, label);
    }
    if (e.tag === 'svg' && (r.w <= 1 || r.h <= 1)) {
      push('broken_media', `Inline SVG "${label}" renders at ${Math.round(r.w)}x${Math.round(r.h)}px — effectively invisible.`, label);
    }
  }

  // Severe overlaps between visible text/interactive elements that are not
  // ancestor/descendant of each other.
  const overlapCandidates = meaningful.filter((e) => isVisible(e)
    && (e.isHeading || e.isInteractive || (e.textLength >= 8 && (e.tag === 'p' || e.tag === 'li'))));
  for (let i = 0; i < overlapCandidates.length; i += 1) {
    for (let j = i + 1; j < overlapCandidates.length; j += 1) {
      const a = overlapCandidates[i];
      const b = overlapCandidates[j];
      if (a.aiId && (b.ancestors || []).includes(a.aiId)) continue;
      if (b.aiId && (a.ancestors || []).includes(b.aiId)) continue;
      const area = overlapArea(a.rect, b.rect);
      if (!area) continue;
      const smaller = Math.min(a.rect.w * a.rect.h, b.rect.w * b.rect.h);
      if (smaller > 0 && area / smaller > OVERLAP_RATIO) {
        push('severe_overlap',
          `"${a.aiId || a.key}" and "${b.aiId || b.key}" overlap by ${Math.round((area / smaller) * 100)}% at ${vw}px — text/controls are sitting on top of each other.`,
          a.aiId || a.key);
      }
    }
  }

  // Empty / collapsed sections.
  for (const s of sections) {
    const label = s.aiId || 'section';
    if (s.rect.h < EMPTY_SECTION_MIN_HEIGHT && !s.hasSlot) {
      push('empty_section', `Section "${label}" renders ${Math.round(s.rect.h)}px tall — effectively empty.`, label);
    } else if (s.textLength < 10 && !s.hasSlot && !s.hasSvg) {
      push('empty_section', `Section "${label}" contains no visible text or reserved component.`, label);
    }
    if (s.maxChildHeight > EMPTY_SECTION_MIN_HEIGHT && s.rect.h < s.maxChildHeight * COLLAPSED_PARENT_RATIO) {
      push('invalid_parent_height', `Section "${label}" is ${Math.round(s.rect.h)}px tall but contains a ${Math.round(s.maxChildHeight)}px child — the parent has collapsed (uncleared floats / absolute children).`, label);
    }
  }

  // Missing CTA actions: the document declares actions, but no data-ai-action
  // element is actually visible on the rendered page.
  const declaredActions = Array.isArray(doc?.actions) ? doc.actions.length : 0;
  if (declaredActions > 0) {
    const visibleActions = elements.filter((e) => e.action && isVisible(e));
    if (!visibleActions.length) {
      push('missing_cta', `The document declares ${declaredActions} action(s) but no visible element carries data-ai-action on the rendered page.`);
    }
  }

  return { ok: true, issues, captureError: null };
}

/**
 * Inspect all captured breakpoints. `captures` is
 *   [{ breakpoint, width, metrics }] — metrics may carry { error } envelopes.
 * Returns { issues, captureErrors, breakpointsInspected }.
 */
export function inspectCodeLayout(captures, { document: doc = null } = {}) {
  const issues = [];
  const captureErrors = [];
  let inspected = 0;
  for (const cap of captures || []) {
    const r = inspectBreakpointMetrics(cap?.metrics, {
      breakpoint: cap?.breakpoint || 'desktop',
      width: cap?.width || 1440,
      document: doc,
    });
    if (!r.ok) {
      captureErrors.push({ breakpoint: cap?.breakpoint || 'desktop', error: r.captureError });
      continue;
    }
    inspected += 1;
    issues.push(...r.issues);
  }
  return { issues, captureErrors, breakpointsInspected: inspected };
}

export function blockingIssues(issues) {
  return (issues || []).filter((i) => i.severity !== 'advisory');
}

/**
 * Deterministic 0–100 quality score used on hard rejection and in the audit
 * trail. Starts at 100; blocking layout issues cost 15, advisory 5, blocking
 * review findings 10, advisory review findings 3.
 */
export function scoreQuality({ layoutIssues = [], review = null } = {}) {
  let score = 100;
  for (const i of layoutIssues) score -= i.severity === 'advisory' ? 5 : 15;
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  for (const f of findings) score -= f.severity === 'blocking' ? 10 : 3;
  return Math.max(0, Math.min(100, score));
}
