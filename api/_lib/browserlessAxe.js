/**
 * Browserless.io axe-core runner.
 *
 * Drives the tenant's browserless.io hosted Chrome via its `/function`
 * endpoint to navigate to a URL, inject axe-core, run axe.run() and return
 * the raw JSON report.
 *
 * Token is read from BROWSERLESS_API_TOKEN. Base URL can be overridden via
 * BROWSERLESS_BASE_URL (defaults to https://chrome.browserless.io).
 *
 * v1 limits enforced here (callers should also enforce):
 *  - per-URL navigation/run timeout (BROWSERLESS_AUDIT_TIMEOUT_MS, default 60s)
 *  - public URLs only (http/https), no auth — caller validates URLs
 */

const DEFAULT_BASE_URL = 'https://chrome.browserless.io';
const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_URLS_PER_RUN = 10;

export function getBrowserlessConfig() {
  const token = process.env.BROWSERLESS_API_TOKEN;
  const baseUrl = process.env.BROWSERLESS_BASE_URL || DEFAULT_BASE_URL;
  const timeoutMs = parseInt(process.env.BROWSERLESS_AUDIT_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
  return { token, baseUrl, timeoutMs };
}

export function isBrowserlessConfigured() {
  return !!process.env.BROWSERLESS_API_TOKEN;
}

const AXE_RUNNER_CODE = `
export default async function ({ page, context }) {
  const { url, navigationTimeout, runTimeout } = context;
  page.setDefaultNavigationTimeout(navigationTimeout);
  page.setDefaultTimeout(runTimeout);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: navigationTimeout });
  } catch (err) {
    return { data: { error: 'navigation_failed', message: String(err && err.message || err) }, type: 'application/json' };
  }
  try {
    await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js' });
  } catch (err) {
    return { data: { error: 'axe_inject_failed', message: String(err && err.message || err) }, type: 'application/json' };
  }
  try {
    const results = await page.evaluate(async () => {
      // Use an explicit context-spec object so axe-core 4.10's
      // normalizeRunParams reliably identifies the first argument as the
      // context (not options). Passing a bare \`document\` reference has
      // been observed to trip "axe.run arguments are invalid" in some
      // browserless evaluation contexts.
      const context = { include: [document.documentElement] };
      const options = { resultTypes: ['violations', 'passes', 'incomplete', 'inapplicable'] };
      return await window.axe.run(context, options);
    });
    return { data: results, type: 'application/json' };
  } catch (err) {
    const axeVersion = 'axe-core@4.10.2';
    const message = String(err && err.message || err);
    return { data: { error: 'axe_run_failed', message: message + ' (' + axeVersion + ')' }, type: 'application/json' };
  }
}
`;

/**
 * Run axe-core against a single URL via browserless.io.
 * Returns the raw axe JSON result.
 * Throws on transport / configuration errors.
 */
export async function runAxeAudit(url) {
  const { token, baseUrl, timeoutMs } = getBrowserlessConfig();
  if (!token) {
    throw new Error('BROWSERLESS_API_TOKEN is not configured');
  }

  const endpoint = `${baseUrl.replace(/\/$/, '')}/function?token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  // Give the HTTP call a slight headroom above the in-page timeout so the
  // function endpoint has time to return its error envelope.
  const httpTimer = setTimeout(() => controller.abort(), timeoutMs + 15_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: AXE_RUNNER_CODE,
        context: {
          url,
          navigationTimeout: timeoutMs,
          runTimeout: timeoutMs,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`browserless returned ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = await response.json();
    if (data && data.error) {
      const msg = data.message || data.error;
      throw new Error(`Audit failed: ${msg}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Audit timed out after ${timeoutMs + 15_000}ms`);
    }
    throw err;
  } finally {
    clearTimeout(httpTimer);
  }
}

/**
 * Summarize an axe-core result into severity counts and a simple score.
 * Score: pass_count / (pass_count + violation_count), 0-100.
 */
export function summarizeAxeResult(axeResult) {
  const summary = {
    critical_count: 0,
    serious_count: 0,
    moderate_count: 0,
    minor_count: 0,
    pass_count: 0,
    violation_count: 0,
    score: null,
  };
  if (!axeResult || typeof axeResult !== 'object') return summary;

  const violations = Array.isArray(axeResult.violations) ? axeResult.violations : [];
  const passes = Array.isArray(axeResult.passes) ? axeResult.passes : [];

  for (const v of violations) {
    const nodes = Array.isArray(v.nodes) ? v.nodes.length : 1;
    summary.violation_count += nodes;
    switch (v.impact) {
      case 'critical': summary.critical_count += nodes; break;
      case 'serious': summary.serious_count += nodes; break;
      case 'moderate': summary.moderate_count += nodes; break;
      case 'minor': summary.minor_count += nodes; break;
      default: break;
    }
  }
  summary.pass_count = passes.length;

  const totalChecks = summary.pass_count + summary.violation_count;
  if (totalChecks > 0) {
    summary.score = Math.round((summary.pass_count / totalChecks) * 100);
  }
  return summary;
}

/**
 * Validate a candidate URL. Accepts http(s) only; rejects auth credentials.
 * Returns the normalized URL string or throws.
 */
export function validateAuditUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('URL must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`URL protocol must be http or https: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL must not contain credentials');
  }
  return parsed.toString();
}
