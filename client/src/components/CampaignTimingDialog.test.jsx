import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { formatCampaignDuration, formatCampaignTimestamp, validateCampaignTimings } from './campaignTimingDisplay.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const name of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node',
  'NodeFilter', 'Event', 'CustomEvent', 'MouseEvent', 'MutationObserver',
]) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
Object.assign(globalThis, {
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: callback => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: CampaignTimingDialog } = await import('./CampaignTimingDialog.jsx');
after(() => dom.window.close());

const campaign = { id: 'alpha', name: 'April members briefing', status: 'sent', created_at: '2026-04-01T09:00:00Z' };
const payload = (id = 'alpha', status = 'sent') => ({
  campaign: { ...campaign, id, status },
  timings: {
    started_at: '2026-04-02T09:00:00Z',
    completed_at: '2026-04-02T09:03:17Z',
    first_recipient_sent_at: '2026-04-02T09:00:23Z',
    last_recipient_sent_at: '2026-04-02T09:02:48Z',
    preparation_duration_ms: 23000, send_duration_ms: 174000, overall_duration_ms: 197000,
    notes: ['Preparation completion was not recorded.'],
  },
});

async function mounted(run, fetchMock) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return fetchMock ? fetchMock(url, options, calls.length) : { ok: true, json: async () => payload() };
  };
  const changes = [];
  const inspections = [];
  const render = async (props = {}) => {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <CampaignTimingDialog campaign={campaign} open={false} onOpenChange={value => changes.push(value)} onInspect={value => inspections.push(value)} {...props} />
      </QueryClientProvider>,
    ));
    await act(async () => new Promise(resolve => setTimeout(resolve, 25)));
  };
  try {
    await run({ render, calls, changes, inspections });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
}
const click = async text => {
  const button = [...document.querySelectorAll('button')].find(element => element.textContent === text);
  assert.ok(button, `Missing button: ${text}`);
  await act(async () => button.click());
  await act(async () => new Promise(resolve => setTimeout(resolve, 25)));
};

test('formats missing values, timezone-specific timestamps and nonnegative durations', () => {
  assert.equal(formatCampaignDuration(null), 'Not available');
  assert.equal(formatCampaignDuration(-3), 'Not available');
  assert.equal(formatCampaignDuration(0), 'Less than 1 second');
  assert.equal(formatCampaignDuration(197000), '3m 17s');
  assert.equal(formatCampaignTimestamp('bad date', 'UTC'), null);
  assert.notEqual(formatCampaignTimestamp('2026-04-02T09:00:00Z', 'UTC'), formatCampaignTimestamp('2026-04-02T09:00:00Z', 'America/New_York'));
});

test('rejects missing endpoint and mismatched campaign responses', () => {
  assert.throws(() => validateCampaignTimings(campaign, 'alpha'), /not available/);
  assert.throws(() => validateCampaignTimings(payload('beta'), 'alpha'), /not available/);
});

test('never shows ongoing finish or invalid historical completion as a finish', () => {
  for (const status of ['draft', 'scheduled', 'preparing', 'sending', 'paused']) {
    const result = validateCampaignTimings(payload('alpha', status), 'alpha');
    assert.equal(result.timings.completed_at, null);
    assert.equal(result.timings.overall_duration_ms, null);
    assert.equal(result.timings.send_duration_ms, null);
  }
  const historic = payload();
  historic.timings.completed_at = '2026-03-30T09:00:00Z';
  const result = validateCampaignTimings(historic, 'alpha');
  assert.equal(result.timings.completed_at, null);
  assert.match(result.timings.notes.join(' '), /predates.*ignored/);
  assert.equal(result.timings.last_recipient_sent_at, historic.timings.last_recipient_sent_at);
});

test('loads only on open, shows recorded evidence and timezone, opens statistics and closes', async () => {
  await mounted(async ({ render, calls, changes, inspections }) => {
    await render();
    assert.equal(calls.length, 0);
    await render({ open: true });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /alpha\?timings=true$/);
    assert.equal(calls[0].options.credentials, 'include');
    assert.ok(calls[0].options.signal);
    assert.match(document.body.textContent, /All times in/);
    assert.match(document.body.textContent, /3m 17s/);
    assert.match(document.body.textContent, /not independently verified Mailgun/);
    assert.match(document.body.textContent, /Preparation completion was not recorded/);
    await click('Open statistics');
    assert.deepEqual(changes, [false]);
    assert.equal(inspections[0].id, 'alpha');
    await click('Close');
    assert.deepEqual(changes, [false, false]);
  });
});

test('has a loading skeleton, retryable error and no stale details after switching campaigns', async () => {
  let resolveSecond;
  await mounted(async ({ render, calls }) => {
    await render({ open: true });
    assert.match(document.body.textContent, /Timings could not be loaded/);
    await click('Try again');
    assert.equal(calls.length, 2);
    assert.match(document.body.textContent, /3m 17s/);
    await render({ open: true, campaign: { ...campaign, id: 'beta', name: 'May briefing' } });
    assert.ok(document.querySelector('[aria-label="Loading campaign timings"]'));
    assert.doesNotMatch(document.body.textContent, /3m 17s/);
    await act(async () => resolveSecond({ ok: true, json: async () => payload('beta') }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 25)));
    assert.match(document.body.textContent, /May briefing/);
    assert.match(document.body.textContent, /3m 17s/);
  }, (url, options, count) => {
    if (count === 1) return { ok: false, json: async () => ({ error: 'Read temporarily unavailable' }) };
    if (url.includes('/beta?')) return new Promise(resolve => { resolveSecond = resolve; });
    return { ok: true, json: async () => payload() };
  });
});

test('preserves preparation failure explanation and delivery Inspect action', async () => {
  const failedCampaign = {
    ...campaign, status: 'failed', preparation: { phase: 'failed', last_error: 'No recipients found for this campaign' },
    delivery_summary: { sent: 0, excluded: 7, failed: 0, processing: 2, queued: 0, reconciliationAlert: { message: 'Investigate these recipients.' } },
  };
  await mounted(async ({ render, inspections }) => {
    await render({ open: true, campaign: failedCampaign });
    assert.match(document.body.textContent, /failed preparation cannot be resumed/);
    assert.match(document.body.textContent, /7 excluded/);
    await click('Inspect delivery details');
    assert.equal(inspections[0].id, 'alpha');
  }, () => ({ ok: false, json: async () => ({ error: 'Not available' }) }));
});

test('closing aborts the pending timing read and removes the dialog', async () => {
  await mounted(async ({ render, calls }) => {
    await render({ open: true });
    assert.equal(calls.length, 1);
    assert.ok(document.querySelector('[aria-label="Loading campaign timings"]'));
    await render({ open: false });
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  }, () => new Promise(() => {}));
});
