// Tests for the style-reference capture reliability layer (Task #2882):
// error detail passthrough, retry, and the minimal /function fallback in
// captureViewportWithFallback. Browserless is mocked via global fetch.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureViewportBundle,
  captureViewportWithFallback,
} from './styleReferenceCapture.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.BROWSERLESS_API_TOKEN;

const TINY_JPEG_B64 = Buffer.from('fake-jpeg-bytes').toString('base64');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}


function goodFunctionBody() {
  return {
    finalUrl: 'https://example.org/',
    metrics: { page: { pageHeight: 2000 } },
    screenshots: [
      { label: 'desktop_full_page', b64: TINY_JPEG_B64, width: 1440, height: null },
      { label: 'desktop_hero', b64: TINY_JPEG_B64, width: 1440, height: 900 },
    ],
  };
}

let calls;

beforeEach(() => {
  process.env.BROWSERLESS_API_TOKEN = 'test-token';
  calls = [];
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_TOKEN === undefined) delete process.env.BROWSERLESS_API_TOKEN;
  else process.env.BROWSERLESS_API_TOKEN = ORIGINAL_TOKEN;
});

function mockFetch(handler) {
  globalThis.fetch = async (url, options) => {
    let endpoint = 'other';
    if (String(url).includes('/function')) {
      // Rich runner walks elements (usedB64 budget marker); fallback doesn't.
      const body = JSON.parse(options.body);
      endpoint = body.code.includes('usedB64') ? 'function' : 'fallback';
    }
    calls.push({ endpoint, options });
    return handler(endpoint, calls.filter((c) => c.endpoint === endpoint).length);
  };
}

test('captureViewportBundle: success parses screenshots + metrics', async () => {
  mockFetch(() => jsonResponse(goodFunctionBody()));
  const bundle = await captureViewportBundle('https://example.org/', 'desktop');
  assert.equal(bundle.finalUrl, 'https://example.org/');
  assert.equal(bundle.screenshots.length, 2);
  assert.ok(Buffer.isBuffer(bundle.screenshots[0].buffer));
  assert.equal(bundle.metrics.page.pageHeight, 2000);
});

test('captureViewportBundle: runner error carries friendly message + detail', async () => {
  mockFetch(() => jsonResponse({ error: 'navigation_failed', message: 'net::ERR_TIMED_OUT at https://example.org' }));
  await assert.rejects(
    captureViewportBundle('https://example.org/', 'desktop'),
    (err) => {
      assert.equal(err.message, 'The reference page could not be loaded.');
      assert.match(err.detail, /navigation_failed/);
      assert.match(err.detail, /ERR_TIMED_OUT/);
      return true;
    },
  );
});

test('captureViewportBundle: non-2xx carries status detail', async () => {
  mockFetch(() => jsonResponse({ message: 'worker crashed' }, 502));
  await assert.rejects(
    captureViewportBundle('https://example.org/', 'desktop'),
    (err) => {
      assert.equal(err.message, 'Capture service error (502).');
      assert.match(err.detail, /HTTP 502/);
      return true;
    },
  );
});

test('captureViewportBundle: empty screenshots throws with detail', async () => {
  mockFetch(() => jsonResponse({ finalUrl: 'https://example.org/', metrics: null, screenshots: [] }));
  await assert.rejects(
    captureViewportBundle('https://example.org/', 'desktop'),
    (err) => {
      assert.equal(err.message, 'No usable screenshots could be captured from the reference page.');
      assert.match(err.detail, /0 screenshots/);
      return true;
    },
  );
});

test('captureViewportWithFallback: succeeds first try, no attempts recorded', async () => {
  mockFetch(() => jsonResponse(goodFunctionBody()));
  const result = await captureViewportWithFallback('https://example.org/', 'desktop');
  assert.equal(result.usedFallback, false);
  assert.equal(result.attempts.length, 0);
  assert.equal(result.bundle.screenshots.length, 2);
  assert.equal(calls.length, 1);
});

test('captureViewportWithFallback: retries /function once then succeeds', async () => {
  mockFetch((endpoint, n) => {
    if (n === 1) return jsonResponse({ message: 'boom' }, 500);
    return jsonResponse(goodFunctionBody());
  });
  const result = await captureViewportWithFallback('https://example.org/', 'desktop');
  assert.equal(result.usedFallback, false);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].mode, 'function');
  assert.equal(calls.filter((c) => c.endpoint === 'function').length, 2);
  // Retry uses a shorter settle delay.
  const secondBody = JSON.parse(calls[1].options.body);
  const firstBody = JSON.parse(calls[0].options.body);
  assert.ok(secondBody.context.postLoadDelay < firstBody.context.postLoadDelay);
});

test('captureViewportWithFallback: falls back to minimal runner after two failures', async () => {
  mockFetch((endpoint) => {
    if (endpoint === 'function') return jsonResponse({ message: 'boom' }, 500);
    return jsonResponse({
      finalUrl: 'https://example.org/',
      metrics: null,
      screenshots: [{ label: 'desktop_full_page', b64: TINY_JPEG_B64, width: 1440, height: null }],
    });
  });
  const result = await captureViewportWithFallback('https://example.org/', 'desktop');
  assert.equal(result.usedFallback, true);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.bundle.metrics, null);
  assert.equal(result.bundle.screenshots.length, 1);
  assert.equal(result.bundle.screenshots[0].label, 'desktop_full_page');
  assert.ok(Buffer.isBuffer(result.bundle.screenshots[0].buffer));
  assert.equal(calls.filter((c) => c.endpoint === 'function').length, 2);
  assert.equal(calls.filter((c) => c.endpoint === 'fallback').length, 1);
});

test('captureViewportWithFallback: fallback reports REAL post-redirect finalUrl (SSRF revalidation stays intact)', async () => {
  mockFetch((endpoint) => {
    if (endpoint === 'function') return jsonResponse({ message: 'boom' }, 500);
    return jsonResponse({
      finalUrl: 'https://redirected.example.net/landing',
      metrics: null,
      screenshots: [{ label: 'desktop_full_page', b64: TINY_JPEG_B64, width: 1440, height: null }],
    });
  });
  const result = await captureViewportWithFallback('https://example.org/', 'desktop');
  assert.equal(result.usedFallback, true);
  // The endpoint compares bundle.finalUrl to the source URL to re-run the
  // public-target check — fallback must pass the redirect through, never
  // substitute the original URL.
  assert.equal(result.bundle.finalUrl, 'https://redirected.example.net/landing');
});

test('captureViewportWithFallback: fallback rejects unsupported redirect scheme', async () => {
  mockFetch((endpoint) => {
    if (endpoint === 'function') return jsonResponse({ message: 'boom' }, 500);
    return jsonResponse({ error: 'redirected_to_unsupported_scheme', message: 'chrome-error://crash' });
  });
  await assert.rejects(
    captureViewportWithFallback('https://example.org/', 'desktop'),
    (err) => {
      // Combined error keeps the first attempt's friendly message; the
      // fallback rejection is preserved in the technical detail.
      assert.ok(err.message.length > 0);
      assert.match(err.detail, /redirected_to_unsupported_scheme/);
      assert.equal(err.attempts[2].mode, 'fallback');
      return true;
    },
  );
});

test('captureViewportWithFallback: total failure throws combined detail', async () => {
  mockFetch((endpoint) => {
    if (endpoint === 'function') return jsonResponse({ error: 'navigation_failed', message: 'timeout' });
    return jsonResponse({ message: 'nope' }, 500);
  });
  await assert.rejects(
    captureViewportWithFallback('https://example.org/', 'desktop'),
    (err) => {
      assert.equal(err.message, 'The reference page could not be loaded.');
      assert.match(err.detail, /function#1/);
      assert.match(err.detail, /function#2/);
      assert.match(err.detail, /fallback/);
      assert.equal(err.attempts.length, 3);
      return true;
    },
  );
});

test('runner context includes payload budget, walk cap, full-page cap and per-shot cap', async () => {
  mockFetch(() => jsonResponse(goodFunctionBody()));
  await captureViewportBundle('https://example.org/', 'desktop');
  const body = JSON.parse(calls[0].options.body);
  assert.ok(body.context.payloadBudget > 0);
  assert.ok(body.context.maxWalkElements > 0);
  assert.ok(body.context.fullPageCap > 0);
  assert.ok(body.context.maxShotB64 > 0);
  assert.ok(body.code.includes('usedB64'));
  assert.ok(body.code.includes('captureBeyondViewport'));
  assert.ok(body.code.includes('shootErrors'));
});

test('captureViewportBundle: zero screenshots surfaces runner shoot errors in detail', async () => {
  mockFetch(() => jsonResponse({
    finalUrl: 'https://example.org/',
    metrics: null,
    screenshots: [],
    shootErrors: ['desktop_full_page: Protocol error (Page.captureScreenshot): boom'],
  }));
  await assert.rejects(
    captureViewportBundle('https://example.org/', 'desktop'),
    (err) => {
      assert.equal(err.message, 'No usable screenshots could be captured from the reference page.');
      assert.match(err.detail, /shoot errors/);
      assert.match(err.detail, /captureScreenshot.*boom/);
      return true;
    },
  );
});

test('captureViewportBundle: oversized image dropped with size in detail', async () => {
  const hugeB64 = Buffer.alloc(5 * 1024 * 1024).toString('base64'); // > 4MB decoded
  mockFetch(() => jsonResponse({
    finalUrl: 'https://example.org/',
    metrics: null,
    screenshots: [{ label: 'desktop_full_page', b64: hugeB64, width: 1440, height: null }],
  }));
  await assert.rejects(
    captureViewportBundle('https://example.org/', 'desktop'),
    (err) => {
      assert.match(err.detail, /dropped: desktop_full_page: \d+ bytes \(cap \d+\)/);
      return true;
    },
  );
});

test('fallback: oversized screenshot detail includes size and shoot errors', async () => {
  const hugeB64 = Buffer.alloc(5 * 1024 * 1024).toString('base64');
  mockFetch((endpoint) => {
    if (endpoint === 'function') return jsonResponse({ message: 'boom' }, 500);
    return jsonResponse({
      finalUrl: 'https://example.org/',
      metrics: null,
      screenshots: [{ label: 'desktop_full_page', b64: hugeB64, width: 1440, height: null }],
      shootErrors: ['oversize retake: timeout'],
    });
  });
  await assert.rejects(
    captureViewportWithFallback('https://example.org/', 'desktop'),
    (err) => {
      const fb = err.attempts[2];
      assert.equal(fb.mode, 'fallback');
      assert.match(err.detail, /fallback: empty or oversized screenshot — \d+ bytes/);
      assert.match(err.detail, /oversize retake: timeout/);
      return true;
    },
  );
});

test('fallback runner context includes per-shot cap; code has clip-retry + oversize retake', async () => {
  mockFetch((endpoint) => {
    if (endpoint === 'function') return jsonResponse({ message: 'boom' }, 500);
    return jsonResponse({
      finalUrl: 'https://example.org/',
      metrics: null,
      screenshots: [{ label: 'desktop_full_page', b64: TINY_JPEG_B64, width: 1440, height: null }],
    });
  });
  await captureViewportWithFallback('https://example.org/', 'desktop');
  const fb = calls.find((c) => c.endpoint === 'fallback');
  const body = JSON.parse(fb.options.body);
  assert.ok(body.context.maxShotB64 > 0);
  assert.ok(body.code.includes('captureBeyondViewport'));
  assert.ok(body.code.includes('viewport retry'));
  assert.ok(body.code.includes('oversize retake'));
});
