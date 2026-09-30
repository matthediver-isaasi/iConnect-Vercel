/**
 * Browserless.io multi-viewport screenshot capture (Task #2873).
 *
 * Uses the browserless `/screenshot` REST endpoint to render a public URL at
 * the style-reference viewports (desktop/tablet/mobile). Shares config with
 * the axe runner (BROWSERLESS_API_TOKEN / BROWSERLESS_BASE_URL /
 * BROWSERLESS_AUDIT_TIMEOUT_MS).
 *
 * Callers MUST validate the URL first (validateReferenceUrl) — public
 * http(s) only, no credentials, no private hosts.
 */

import { getBrowserlessConfig, isBrowserlessConfigured } from './browserlessAxe.js';
import { SCREENSHOT_VIEWPORTS } from './styleReference.js';

export { isBrowserlessConfigured };

/**
 * Capture ONE screenshot. Returns { buffer, contentType }.
 * Throws Error with a friendly message on failure.
 */
export async function captureScreenshot(url, viewport, { fullPage = true } = {}) {
  const { token, baseUrl, timeoutMs } = getBrowserlessConfig();
  if (!token) throw new Error('Screenshot capture is not configured on this server.');

  const endpoint = `${baseUrl.replace(/\/$/, '')}/screenshot?token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        url,
        viewport: { width: viewport.width, height: viewport.height },
        gotoOptions: { waitUntil: 'networkidle2', timeout: timeoutMs },
        options: {
          type: 'jpeg',
          quality: 70,
          fullPage,
          // Cap extremely long pages: browserless clips via `clip` only, so we
          // rely on fullPage + downstream vision-model downscaling instead.
        },
      }),
    });
  } catch (err) {
    throw new Error(
      err?.name === 'AbortError'
        ? 'The page took too long to render for a screenshot.'
        : 'Could not reach the screenshot service.',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    const msg = resp.status === 400 || resp.status === 500
      ? 'The page could not be rendered — check the URL is public and loads normally.'
      : `Screenshot service error (${resp.status}).`;
    console.error('[browserlessScreenshot] capture failed:', resp.status, detail.slice(0, 300));
    throw new Error(msg);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (!buffer.length) throw new Error('The screenshot service returned an empty image.');
  return { buffer, contentType: 'image/jpeg' };
}

/**
 * Capture all style-reference viewports for a URL.
 * Returns [{ viewport, width, height, buffer, contentType }].
 * Fails as a whole if the desktop capture fails; tablet/mobile failures are
 * tolerated (partial result) so a flaky responsive render degrades gracefully.
 */
export async function captureReferenceScreenshots(url) {
  const results = await Promise.allSettled(
    SCREENSHOT_VIEWPORTS.map(async (vp) => {
      const { buffer, contentType } = await captureScreenshot(url, vp);
      return { viewport: vp.name, width: vp.width, height: vp.height, buffer, contentType };
    }),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (ok.length === 0) {
    const first = results.find((r) => r.status === 'rejected');
    throw new Error(first?.reason?.message || 'Screenshot capture failed.');
  }
  if (!ok.some((r) => r.viewport === 'desktop')) {
    throw new Error('The desktop screenshot could not be captured — please try again.');
  }
  return ok;
}
