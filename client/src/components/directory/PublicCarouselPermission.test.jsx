import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.invalid/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: PublicCarouselPermission } = await import('./PublicCarouselPermission.jsx');

async function mount(isAdmin = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <PublicCarouselPermission source="primary-member" tenantId="tenant-a" isAdmin={isAdmin} />
    </QueryClientProvider>,
  ));
  await settle();
  return { container, async cleanup() { await act(async () => root.unmount()); client.clear(); container.remove(); } };
}
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
}

test('admin consent saves independently, persists on reopening and can be revoked', async () => {
  let saved = false;
  const writes = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/directory-carousel/settings?source=primary-member');
    if (options.method === 'PUT') {
      saved = JSON.parse(options.body).enabled;
      writes.push(saved);
    }
    return new Response(JSON.stringify({ enabled: saved }));
  };
  let view = await mount();
  try {
    let toggle = view.container.querySelector('[role=switch]');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    await act(async () => toggle.click());
    await settle();
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    await view.cleanup();
    view = await mount();
    toggle = view.container.querySelector('[role=switch]');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    await act(async () => toggle.click());
    await settle();
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.deepEqual(writes, [true, false]);
  } finally { await view.cleanup(); }
});

test('non-admins never fetch or render consent; failed reads cannot be saved', async () => {
  let reads = 0;
  globalThis.fetch = async () => { reads++; return new Response('{}', { status: 503 }); };
  let view = await mount(false);
  try {
    assert.equal(reads, 0);
    assert.equal(view.container.textContent, '');
  } finally { await view.cleanup(); }
  view = await mount();
  try {
    assert.equal(reads, 1);
    assert.equal(view.container.querySelector('[role=switch]').disabled, true);
    assert.match(view.container.querySelector('[role=alert]').textContent, /Could not load/);
  } finally { await view.cleanup(); }
});

test('failed save keeps previous consent and displays an error', async () => {
  globalThis.fetch = async (_url, options) => options.method === 'PUT'
    ? new Response(JSON.stringify({ error: 'Permission was not saved' }), { status: 503 })
    : new Response(JSON.stringify({ enabled: false }));
  const view = await mount();
  try {
    const toggle = view.container.querySelector('[role=switch]');
    await act(async () => toggle.click());
    await settle();
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.match(view.container.querySelector('[role=alert]').textContent, /not saved/);
  } finally { await view.cleanup(); }
});
