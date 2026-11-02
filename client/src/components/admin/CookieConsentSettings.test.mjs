import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://admin.example.test/' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const bundle = await build({
  entryPoints: ['client/src/components/admin/CookieConsentSettings.jsx'],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  plugins: [{
    name: 'mock-auth-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^@\/api\/base44Client$/ }, () => ({ path: 'tenant', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@\/lib\/queryClient$/ }, () => ({ path: 'events', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
        contents: args.path === 'tenant'
          ? 'export const getActiveTenantId = () => "stale-global-tenant";'
          : 'export const emitTenantContextChanged = () => {};',
        loader: 'js',
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/cookie-consent-ui-test.cjs`);
compiled.filename = `${process.cwd()}/cookie-consent-ui-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Settings = compiled.exports.default;
const React = compiled.require('react');
const { act } = React;
const { createRoot } = compiled.require('react-dom/client');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });

const config = {
  title: 'Your privacy choices', description: 'Choose which cookies this site can use.',
  privacyUrl: '/privacy', cookieUrl: 'https://example.test/cookies', language: 'en',
  analyticsEnabled: true, policyVersion: '2026-04', retentionDays: 180,
  enabled: false, pilotTenantIds: [],
};
const pilotId = '6bda383b-bd78-4c1e-9fc3-c0e1b4bc964c';
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
const click = element => act(async () => { element.click(); });
function button(container, text) {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent === text);
  assert.ok(result, `Missing button: ${text}`);
  return result;
}
function field(container, label) {
  const target = [...container.querySelectorAll('label')].find(item => item.textContent === label);
  assert.ok(target, `Missing label: ${label}`);
  return document.getElementById(target.htmlFor);
}
async function input(element, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function mount(props = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Settings, props)); });
  await settle();
  return { container, async cleanup() { await act(async () => root.unmount()); container.remove(); } };
}

test('tenant edits only overrides, preserves inheritance, and isolates the unsaved preview', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'PUT') {
      const { overrides } = JSON.parse(options.body);
      return response({ overrides, effective: { ...config, ...overrides } });
    }
    return response({ overrides: {}, effective: config, ga4MeasurementId: 'G-TEST123' });
  };
  const view = await mount({ tenantId: 'current-tenant' });
  try {
    const { container } = view;
    assert.equal(calls[0].url, '/api/admin/cookie-consent');
    assert.equal(calls[0].options.credentials, 'include');
    assert.equal(calls[0].options.headers.get('X-Tenant-Id'), 'current-tenant');
    assert.match(container.textContent, /Following platform defaults/);
    assert.equal(field(container, 'Existing GA4 measurement ID').readOnly, true);
    assert.equal(field(container, 'Language').readOnly, true);
    assert.equal(container.querySelector('[aria-label="Platform rollout"]'), null);
    assert.equal(button(container, 'Save consent settings').disabled, true);
    await input(field(container, 'Banner title'), 'Our cookie choices');
    await click(button(container, 'Open preview'));
    const iframe = container.querySelector('iframe');
    assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(iframe.getAttribute('referrerpolicy'), 'no-referrer');
    const src = iframe.getAttribute('src');
    assert.ok(src.startsWith('/cookie-consent-preview.html#'));
    assert.deepEqual(JSON.parse(decodeURIComponent(src.split('#')[1])), {
      config: { ...config, title: 'Our cookie choices' },
    });
    assert.equal(calls.length, 1, 'preview sends no API, audit, or tracking requests');
    await click(button(container, 'Save consent settings'));
    const saved = calls.find(call => call.options.method === 'PUT');
    assert.deepEqual(JSON.parse(saved.options.body), { overrides: { title: 'Our cookie choices' } });
    assert.equal(saved.options.credentials, 'include');
    assert.match(container.textContent, /Cookie consent settings saved/);
    assert.equal(field(container, 'Existing GA4 measurement ID').value, 'G-TEST123');
  } finally { await view.cleanup(); }
});

test('reset requires confirmation and sends empty overrides to restore inheritance', async () => {
  let saved;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'PUT') {
      saved = JSON.parse(options.body);
      return response({ overrides: {}, effective: config });
    }
    return response({ overrides: { analyticsEnabled: false }, effective: { ...config, analyticsEnabled: false } });
  };
  const view = await mount({ tenantId: 'tenant-a' });
  try {
    await click(button(view.container, 'Use platform defaults'));
    assert.equal(saved, undefined);
    await click(button(view.container, 'Cancel'));
    assert.equal(saved, undefined);
    await click(button(view.container, 'Use platform defaults'));
    await click(button(view.container, 'Confirm reset'));
    assert.deepEqual(saved, { overrides: {} });
    assert.match(view.container.textContent, /This site now inherits platform defaults/);
    assert.equal(field(view.container, 'Allow consent-based analytics').getAttribute('aria-checked'), 'true');
  } finally { await view.cleanup(); }
});

test('platform edits rollout, pilots and numeric retention using the platform endpoint', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'PUT') {
      const { overrides } = JSON.parse(options.body);
      return response({ overrides, effective: { ...config, ...overrides } });
    }
    return response({ overrides: {}, effective: config,
      tenants: [{ id: pilotId, name: 'Ashford Network', complete: true, active: false }] });
  };
  const view = await mount({ platform: true });
  try {
    assert.equal(calls[0].url, '/api/platform/cookie-consent');
    assert.equal(calls[0].options.credentials, 'include');
    assert.match(view.container.textContent, /Complete/);
    assert.match(view.container.textContent, /Inactive/);
    await click(field(view.container, 'Enable platform tracking'));
    await click(view.container.querySelector('input[type="checkbox"]'));
    await input(field(view.container, 'Consent retention (days)'), '240');
    await click(button(view.container, 'Save consent settings'));
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
      overrides: { enabled: true, pilotTenantIds: [pilotId], retentionDays: 240 },
    });
    assert.equal(calls.at(-1).url, '/api/platform/cookie-consent');
    await input(field(view.container, 'Consent retention (days)'), '731');
    await click(button(view.container, 'Save consent settings'));
    assert.match(view.container.querySelector('[role="alert"]').textContent, /whole number between 7 and 730/);
    assert.equal(calls.length, 2, 'invalid retention never reaches the API');
  } finally { await view.cleanup(); }
});

test('load errors offer retry; save validation errors stay visible and preserve draft', async () => {
  let attempt = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'PUT') return response({ error: 'privacyUrl must be a same-origin path or HTTPS URL.' }, 400);
    if (++attempt === 1) return response({ error: 'Cookie consent is temporarily unavailable.' }, 503);
    return response({ overrides: {}, effective: config });
  };
  const view = await mount({ tenantId: 'tenant-a' });
  try {
    assert.match(view.container.querySelector('[role="alert"]').textContent, /temporarily unavailable/);
    await click(button(view.container, 'Retry loading settings'));
    await settle();
    await input(field(view.container, 'Privacy policy URL'), 'http://invalid.test');
    await click(button(view.container, 'Save consent settings'));
    assert.match(view.container.querySelector('[role="alert"]').textContent, /Settings were not saved.*privacyUrl/);
    assert.equal(field(view.container, 'Privacy policy URL').value, 'http://invalid.test');
    assert.equal(button(view.container, 'Save consent settings').disabled, false);
  } finally { await view.cleanup(); }
});

test('PUT without effective response reloads authoritative configuration', async () => {
  let state = { overrides: {}, effective: config };
  globalThis.fetch = async (url, options) => {
    if (options.method === 'PUT') {
      const { overrides } = JSON.parse(options.body);
      state = { overrides, effective: { ...config, ...overrides } };
      return new Response(null, { status: 204 });
    }
    return response(state);
  };
  const view = await mount();
  try {
    await input(field(view.container, 'Banner title'), 'Saved title');
    await click(button(view.container, 'Save consent settings'));
    assert.match(view.container.textContent, /Cookie consent settings saved/);
    assert.equal(field(view.container, 'Banner title').value, 'Saved title');
    assert.equal(button(view.container, 'Save consent settings').disabled, true);
  } finally { await view.cleanup(); }
});
