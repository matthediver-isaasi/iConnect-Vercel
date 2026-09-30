/**
 * Complex-event session Zoom "Link Existing" picker (Task #3414).
 *
 * ZoomSessionConfig replaces the manual Zoom ID text input with a dropdown of
 * upcoming Zoom meetings/webinars fetched from /api/zoom/meetings|webinars.
 * These tests prove:
 *  1. Selecting mode: the dropdown trigger renders (not the manual input) and
 *     the query hits the endpoint matching the session's zoom_type.
 *  2. A stored ID that matches a fetched upcoming item shows the confirmation
 *     summary (topic + date + duration).
 *  3. A legacy manually-entered ID absent from the upcoming list is preserved
 *     and surfaced as a raw-ID fallback (no data loss).
 *  4. When the list fetch fails (e.g. Zoom not connected) the manual ID input
 *     is shown as a fallback and writes link_existing_zoom_id via onUpdate.
 *
 * Runs under tsx (see the `test` workflow) because it needs JSX + @ aliases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.DOMParser = window.DOMParser;
globalThis.MutationObserver = window.MutationObserver;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const ZoomSessionConfig = (await import('./ZoomSessionConfig.jsx')).default;

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

const MEETINGS = [
  {
    id: 'row-1',
    zoom_meeting_id: '11122233344',
    topic: 'Monthly Members Call',
    start_time: FUTURE,
    duration_minutes: 45,
    timezone: 'Europe/London',
    status: 'scheduled',
  },
];

const WEBINARS = [
  {
    id: 'row-w1',
    zoom_webinar_id: '99988877766',
    topic: 'Annual Conference Webinar',
    start_time: FUTURE,
    duration_minutes: 90,
    timezone: 'Europe/London',
    status: 'scheduled',
  },
];

function mockFetch({ fail = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (fail) {
      return { ok: false, json: async () => ({ error: 'Zoom not connected' }) };
    }
    const body = String(url).includes('/webinars') ? WEBINARS : MEETINGS;
    return { ok: true, json: async () => body };
  };
  return calls;
}

async function renderConfig(props) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(ZoomSessionConfig, {
          zoomLinkMode: 'link_existing',
          onUpdate: props.onUpdate || (() => {}),
          zoomUsers: [],
          ...props,
        })
      )
    );
  });
  // let the query settle
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

test('link_existing renders dropdown (not manual input) and queries the meetings endpoint', async () => {
  const calls = mockFetch();
  const { container, cleanup } = await renderConfig({ zoomType: 'meeting' });
  assert.ok(
    container.querySelector('[data-testid="select-session-existing-zoom-trigger"]'),
    'dropdown trigger should render'
  );
  assert.equal(
    container.querySelector('[data-testid="input-session-existing-zoom-id"]'),
    null,
    'manual input should not render when the list loads'
  );
  assert.ok(calls.some((u) => u.includes('/api/zoom/meetings')), 'fetched meetings endpoint');
  await cleanup();
});

test('webinar zoom_type queries the webinars endpoint', async () => {
  const calls = mockFetch();
  const { cleanup } = await renderConfig({ zoomType: 'webinar' });
  assert.ok(calls.some((u) => u.includes('/api/zoom/webinars')), 'fetched webinars endpoint');
  assert.ok(!calls.some((u) => u.includes('/api/zoom/meetings')), 'did not fetch meetings');
  await cleanup();
});

test('stored ID matching an upcoming meeting shows the confirmation summary', async () => {
  mockFetch();
  const { container, cleanup } = await renderConfig({
    zoomType: 'meeting',
    linkExistingZoomId: '11122233344',
  });
  const summary = container.querySelector('[data-testid="session-existing-zoom-summary"]');
  assert.ok(summary, 'summary should render for a matched selection');
  assert.match(summary.textContent, /Monthly Members Call/);
  assert.match(summary.textContent, /45 minutes/);
  await cleanup();
});

test('legacy stored ID not in the upcoming list is preserved and shown raw', async () => {
  mockFetch();
  const { container, cleanup } = await renderConfig({
    zoomType: 'meeting',
    linkExistingZoomId: '55500011122',
  });
  const raw = container.querySelector('[data-testid="session-existing-zoom-raw-id"]');
  assert.ok(raw, 'raw-ID fallback should render');
  assert.match(raw.textContent, /55500011122/);
  assert.equal(
    container.querySelector('[data-testid="session-existing-zoom-summary"]'),
    null,
    'no confirmation summary for an unmatched ID'
  );
  await cleanup();
});

test('list fetch failure falls back to the manual ID input wired to link_existing_zoom_id', async () => {
  mockFetch({ fail: true });
  const updates = [];
  const { container, cleanup } = await renderConfig({
    zoomType: 'meeting',
    onUpdate: (u) => updates.push(u),
  });
  const input = container.querySelector('[data-testid="input-session-existing-zoom-id"]');
  assert.ok(input, 'manual input should render when the list fails to load');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(input, ' 12345678901 ');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.deepEqual(updates.at(-1), { link_existing_zoom_id: '12345678901' });
  await cleanup();
});
