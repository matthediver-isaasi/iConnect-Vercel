/**
 * AI Composition screenshot quality review — Task #2894 (gate 5).
 *
 * Server-side, per-breakpoint screenshot review of the FINAL generated
 * composition: a static HTML page is built from the document (same scoped
 * stylesheet the real renderer uses, via buildAicCss), captured with
 * browserless.io hosted Chrome at each gate breakpoint, and judged by a
 * vision model against blunt pass/fail criteria (unreadable text stack,
 * blank render, severe overlap, content off-screen).
 *
 * Failure semantics (deliberate):
 *   - This gate NEVER fails the generation job — the run completes and the
 *     draft is saved so the author can inspect it. The verdict is stored on
 *     the version's validation_result.gates.screenshotReview and the client
 *     blocks Insert while the verdict is `fail`.
 *   - When browserless or the vision model is unconfigured/unavailable the
 *     gate records `skipped` and does NOT block anything (a missing tool is
 *     not evidence of a bad design).
 */

import { buildAicCss, orderedElements, headingTag } from '../../client/src/lib/aiCompositionRender.js';
import { GATE_BREAKPOINT_WIDTHS, textOf } from './aiCompositionQualityGates.js';

const DEFAULT_BASE_URL = 'https://chrome.browserless.io';
const SHOT_TIMEOUT_MS = 12000;
// Hard wall-clock budget for the whole review (captures + vision). The stage
// runs inside a serverless invocation; when the budget is spent the gate
// degrades to `skipped` instead of risking a function timeout.
const REVIEW_BUDGET_MS = 35000;
const VIEWPORT_HEIGHT = 900;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function elementHtml(doc, el) {
  if (!el || !el.id) return '';
  const cls = `aic-e-${String(el.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const kids = Array.isArray(el.children) ? el.children.map((c) => elementHtml(doc, c)).join('') : '';
  const text = textOf(el);
  switch (el.type) {
    case 'heading': {
      const tag = headingTag(el);
      return `<${tag} class="${cls}">${esc(text)}</${tag}>`;
    }
    case 'paragraph':
    case 'label':
    case 'caption':
    case 'statistic':
      return `<p class="${cls}">${esc(text)}</p>`;
    case 'button':
    case 'text_link':
      return `<a class="${cls}" href="#">${esc(text || 'Learn more')}</a>`;
    case 'image':
    case 'generated_illustration': {
      const src = el.asset?.url || el.content?.url || '';
      if (src && /^https?:\/\//i.test(src)) {
        return `<img class="${cls}" src="${esc(src)}" alt="${esc(el.altText || '')}" />`;
      }
      // Unresolved asset: paint a visible placeholder box so the reviewer
      // judges composition, not a missing network fetch.
      return `<div class="${cls}" style="background:#e2e8f0;min-height:120px"></div>`;
    }
    case 'divider':
      return `<hr class="${cls}" />`;
    case 'spacer':
      return `<div class="${cls}"></div>`;
    case 'background':
    case 'section_background':
      return `<div class="${cls}">${kids}</div>`;
    default:
      // containers, cards, groups, overlays, infographic structures…
      return `<div class="${cls}">${text ? `<p>${esc(text)}</p>` : ''}${kids}</div>`;
  }
}

/**
 * Build a self-contained static HTML page for screenshotting. Mirrors the
 * real renderer's structure (data-aic scope, aic-s-/aic-e- classes) so the
 * generated stylesheet applies exactly.
 */
export function buildGateHtml(doc, { breakpoint = 'desktop', brand = null } = {}) {
  const instanceId = 'gate';
  const css = buildAicCss(doc, instanceId);
  const bodyFont = brand?.typography?.bodyFont || brand?.bodyFont || 'system-ui, sans-serif';
  const sections = (doc?.sections || []).map((s) => {
    const cls = `aic-s-${String(s.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const inner = orderedElements(s).map((el) => elementHtml(doc, el)).join('');
    return `<section class="${cls}" style="position:relative">${inner}</section>`;
  }).join('');
  const bpAttr = breakpoint === 'desktop' ? '' : ` data-aic-bp="${esc(breakpoint)}"`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{font-family:${esc(bodyFont)};background:#fff}
[data-aic] img{max-width:100%;display:block}
${css}
</style></head><body><div data-aic="${instanceId}"${bpAttr}>${sections}</div></body></html>`;
}

/** Capture one breakpoint screenshot via browserless.io. Returns a data URL. */
export async function captureBreakpointScreenshot({ html, width, fetchImpl = fetch }) {
  const token = process.env.BROWSERLESS_API_TOKEN;
  if (!token) throw new Error('browserless is not configured');
  const base = (process.env.BROWSERLESS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHOT_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${base}/screenshot?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        html,
        viewport: { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 },
        options: { type: 'jpeg', quality: 60, fullPage: true },
        gotoOptions: { waitUntil: 'networkidle2', timeout: 15000 },
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`browserless returned ${resp.status}: ${body.slice(0, 300)}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } finally {
    clearTimeout(timer);
  }
}

export function buildScreenshotReviewPrompt({ doc }) {
  const system = `You are a strict quality inspector for AI-generated web page sections. You are shown full-page screenshots of ONE design at desktop, tablet and mobile widths.
Respond ONLY with JSON:
{ "verdicts": [ { "breakpoint": "desktop"|"tablet"|"mobile", "pass": boolean, "issues": [string] } ] }
FAIL a breakpoint ONLY for blunt, objective defects:
- text rendered on top of other text (unreadable stacking)
- an essentially blank/empty render (no visible content)
- content cut off or pushed outside the visible canvas
- images or boxes covering the text
Do NOT fail for taste: spacing preferences, colour choices, typography style or density are acceptable. When unsure, pass.`;
  const names = (doc?.sections || []).map((s) => s.id).join(', ');
  const user = `The design has ${doc?.sections?.length || 0} section(s): ${names}. Review each screenshot and return a verdict per breakpoint.`;
  return { system, user };
}

export function parseScreenshotReview(raw, breakpoints) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || ''));
  } catch {
    return null;
  }
  const list = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
  const out = {};
  for (const bp of breakpoints) {
    const v = list.find((x) => x && x.breakpoint === bp);
    out[bp] = {
      pass: v ? v.pass !== false : true,
      issues: Array.isArray(v?.issues)
        ? v.issues.filter((i) => typeof i === 'string').slice(0, 10).map((i) => i.slice(0, 300))
        : [],
    };
  }
  return out;
}

/**
 * Run the screenshot quality review over every gate breakpoint.
 * Returns { status: 'pass'|'fail'|'skipped', breakpoints?, reason?, checkedAt }.
 * Never throws: any infrastructure failure degrades to `skipped`.
 */
export async function runScreenshotReview({ doc, brand = null, callVision, fetchImpl = fetch, budgetMs = REVIEW_BUDGET_MS }) {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);
  if (!process.env.BROWSERLESS_API_TOKEN) {
    return { status: 'skipped', reason: 'screenshot service not configured', checkedAt };
  }
  if (typeof callVision !== 'function') {
    return { status: 'skipped', reason: 'vision review not configured', checkedAt };
  }
  const breakpoints = Object.keys(GATE_BREAKPOINT_WIDTHS);
  let images;
  try {
    // Captures run in parallel; the whole batch races the stage budget so a
    // slow screenshot service degrades to `skipped`, never a function timeout.
    const captureAll = Promise.all(breakpoints.map(async (bp) => {
      const html = buildGateHtml(doc, { breakpoint: bp, brand });
      const dataUrl = await captureBreakpointScreenshot({ html, width: GATE_BREAKPOINT_WIDTHS[bp], fetchImpl });
      return { breakpoint: bp, dataUrl };
    }));
    images = await Promise.race([
      captureAll,
      new Promise((_, reject) => setTimeout(() => reject(new Error('review budget exhausted')), Math.max(0, remaining())).unref?.() ?? undefined),
    ]);
  } catch (err) {
    return { status: 'skipped', reason: `screenshot capture failed: ${String(err?.message || err).slice(0, 200)}`, checkedAt };
  }
  if (remaining() <= 2000) {
    return { status: 'skipped', reason: 'review budget exhausted before vision review', checkedAt };
  }
  let raw;
  try {
    const { system, user } = buildScreenshotReviewPrompt({ doc });
    raw = await Promise.race([
      callVision({ system, user, images }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('review budget exhausted')), Math.max(0, remaining())).unref?.() ?? undefined),
    ]);
  } catch {
    return { status: 'skipped', reason: 'vision review unavailable', checkedAt };
  }
  const verdicts = parseScreenshotReview(raw, breakpoints);
  if (!verdicts) {
    return { status: 'skipped', reason: 'vision review returned an unreadable response', checkedAt };
  }
  const failed = breakpoints.filter((bp) => !verdicts[bp].pass);
  return {
    status: failed.length ? 'fail' : 'pass',
    breakpoints: verdicts,
    failedBreakpoints: failed,
    checkedAt,
  };
}
