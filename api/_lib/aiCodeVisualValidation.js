// AI Design Studio V2 — Phase 3 evidence capture orchestrator (Task #2907).
//
// One budgeted pass over the signed CSP-locked preview URL: per breakpoint it
// captures a full-page screenshot AND browser-computed layout metrics (via
// the Browserless /function endpoint). All captures run in parallel under a
// hard wall-clock budget; whatever lands in time becomes evidence, the rest
// is recorded as a capture failure. A total capture failure is *skipped*
// validation, never a design rejection (V1 lesson: infrastructure trouble is
// not evidence of a bad design).
//
// Network callers are injectable for tests.

import { captureScreenshot, isBrowserlessConfigured } from './browserlessScreenshot.js';
import { getBrowserlessConfig } from './browserlessAxe.js';
import { LAYOUT_METRICS_RUNNER_CODE } from './aiCodeLayoutInspector.js';

export const VALIDATION_CAPTURE_BUDGET_MS = 40_000;

const VIEWPORT_HEIGHTS = { desktop: 900, tablet: 768, mobile: 844 };

export function viewportsForTargets(targets) {
  const t = targets || {};
  return [
    { name: 'desktop', width: t.desktop || 1440, height: VIEWPORT_HEIGHTS.desktop },
    { name: 'tablet', width: t.tablet || 1024, height: VIEWPORT_HEIGHTS.tablet },
    { name: 'mobile', width: t.mobile || 390, height: VIEWPORT_HEIGHTS.mobile },
  ];
}

/** Default metrics capturer — Browserless /function running the collector. */
export async function captureLayoutMetrics(previewUrl, viewport, { fetchImpl = fetch } = {}) {
  const { token, baseUrl, timeoutMs } = getBrowserlessConfig();
  if (!token) throw new Error('BROWSERLESS_API_TOKEN is not configured');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/function?token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 10_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: LAYOUT_METRICS_RUNNER_CODE,
        context: {
          url: previewUrl,
          width: viewport.width,
          height: viewport.height,
          navigationTimeout: Math.min(timeoutMs, 30_000),
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`browserless returned ${response.status}: ${body.slice(0, 300)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const withBudget = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded the ${ms}ms capture budget`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Capture screenshots + metrics for every breakpoint of one candidate
 * version, in parallel, within `budgetMs`.
 *
 * @param storeShot async ({ buffer, breakpoint, width }) => { url, fileRepositoryId }
 * @returns {
 *   status: 'captured'|'skipped',
 *   screenshots: [{ breakpoint, width, url, fileRepositoryId, capturedAt }],
 *   metricsCaptures: [{ breakpoint, width, metrics }],
 *   failures: [{ breakpoint, kind, error }],
 *   skipReason?: string,
 * }
 */
export async function captureValidationEvidence({
  previewUrl,
  responsiveTargets = null,
  storeShot,
  budgetMs = VALIDATION_CAPTURE_BUDGET_MS,
  screenshotImpl = captureScreenshot,
  metricsImpl = captureLayoutMetrics,
  configuredImpl = isBrowserlessConfigured,
}) {
  if (!previewUrl) {
    return { status: 'skipped', screenshots: [], metricsCaptures: [], failures: [], skipReason: 'Preview signing is not configured' };
  }
  if (!configuredImpl()) {
    return { status: 'skipped', screenshots: [], metricsCaptures: [], failures: [], skipReason: 'Browserless is not configured' };
  }

  const viewports = viewportsForTargets(responsiveTargets);
  const screenshots = [];
  const metricsCaptures = [];
  const failures = [];

  const tasks = [];
  for (const vp of viewports) {
    tasks.push((async () => {
      try {
        const { buffer } = await withBudget(
          screenshotImpl(previewUrl, { width: vp.width, height: vp.height }, { fullPage: true }),
          budgetMs, `${vp.name} screenshot`,
        );
        const stored = await storeShot({ buffer, breakpoint: vp.name, width: vp.width });
        screenshots.push({
          breakpoint: vp.name,
          width: vp.width,
          url: stored.url,
          fileRepositoryId: stored.fileRepositoryId || null,
          capturedAt: new Date().toISOString(),
        });
      } catch (err) {
        failures.push({ breakpoint: vp.name, kind: 'screenshot', error: err.message });
      }
    })());
    tasks.push((async () => {
      try {
        const metrics = await withBudget(
          metricsImpl(previewUrl, vp), budgetMs, `${vp.name} metrics`,
        );
        metricsCaptures.push({ breakpoint: vp.name, width: vp.width, metrics });
      } catch (err) {
        failures.push({ breakpoint: vp.name, kind: 'metrics', error: err.message });
      }
    })());
  }
  await Promise.all(tasks);

  // Stable breakpoint order regardless of completion order.
  const order = { desktop: 0, tablet: 1, mobile: 2 };
  screenshots.sort((a, b) => (order[a.breakpoint] ?? 9) - (order[b.breakpoint] ?? 9));
  metricsCaptures.sort((a, b) => (order[a.breakpoint] ?? 9) - (order[b.breakpoint] ?? 9));

  if (!screenshots.length && !metricsCaptures.length) {
    return {
      status: 'skipped',
      screenshots: [],
      metricsCaptures: [],
      failures,
      skipReason: 'All Browserless captures failed',
    };
  }
  return { status: 'captured', screenshots, metricsCaptures, failures };
}
