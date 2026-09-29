import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/communications', pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
for (const name of [
  'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
  'MutationObserver', 'getComputedStyle', 'localStorage', 'location',
]) {
  Object.defineProperty(globalThis, name, {
    value: window[name], configurable: true, writable: true,
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.localStorage.setItem('tenant_slug', 'test-tenant');
const originalFetch = globalThis.fetch;
let request;
globalThis.fetch = async (url) => {
  assert.match(url, /\/api\/public\/communication-categories/);
  return request();
};
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

const bundle = await build({
  entryPoints: ['client/src/components/forms/FormRenderer.jsx'],
  bundle: true, write: false, packages: 'external',
  platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const bundledModule = new Module(`${process.cwd()}/form-renderer-communication-test-memory.cjs`);
bundledModule.filename = `${process.cwd()}/form-renderer-communication-test-memory.cjs`;
bundledModule.paths = Module._nodeModulePaths(process.cwd());
bundledModule._compile(bundle.outputFiles[0].text, bundledModule.filename);
const FormRenderer = bundledModule.exports.default;
const require = createRequire(import.meta.url);
const React = require('react');
globalThis.React = React;
const { act } = React;
const { createRoot } = require('react-dom/client');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const h = React.createElement;
const categories = [
  { id: 'role-public', name: 'Public scoped', is_public: true, member_enabled: false, role_ids: ['graduate'] },
  { id: 'private', name: 'Private', is_public: false, member_enabled: true, role_ids: [] },
  { id: 'member', name: 'Member scoped', is_public: true, member_enabled: true, role_ids: ['graduate'] },
];
const success = () => ({ ok: true, json: async () => categories });

async function mount({ initialValue = {}, rendererProps = {}, queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
}) } = {}) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  const changes = [];
  const render = props => act(async () => root.render(h(QueryClientProvider, { client: queryClient },
    h(FormRenderer, {
      field: { id: 'preferences', type: 'communication_preferences', default_selected_category_ids: ['role-public', 'private'] },
      value: initialValue,
      onChange: value => changes.push(value),
      ...props,
    }))));
  await render(rendererProps);
  return {
    element, changes, render,
    cleanup: async () => {
      await act(async () => root.unmount());
      element.remove();
      queryClient.clear();
    },
  };
}
const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 15)));

test('genuine anonymous visitor sees public role-scoped category and receives only eligible defaults', async () => {
  request = success;
  const view = await mount();
  await settle();
  assert.ok(view.element.querySelector('[data-testid="comm-pref-category-role-public"]'));
  assert.equal(view.element.querySelector('[data-testid="comm-pref-category-private"]'), null);
  assert.deepEqual(view.changes[0], { 'role-public': true, member: false });
  await view.cleanup();
});

test('roleless creation is member context, and existing member role takes precedence', async () => {
  request = success;
  const view = await mount({ rendererProps: { communicationMemberContext: true } });
  await settle();
  assert.equal(view.element.querySelector('[data-testid="comm-pref-category-role-public"]'), null);
  assert.equal(view.element.querySelector('[data-testid="comm-pref-category-member"]'), null);
  assert.ok(view.element.querySelector('[data-testid="comm-pref-category-private"]'));
  await view.cleanup();

  const known = await mount({
    rendererProps: { memberInfo: { id: 'known', role_id: 'other' }, formMemberRoleId: 'other', communicationMemberContext: true },
  });
  await settle();
  assert.equal(known.element.querySelector('[data-testid="comm-pref-category-member"]'), null);
  await known.cleanup();
});

test('failed category fetch retains saved value, renders retry, and only reconciles after success', async () => {
  request = () => ({ ok: false, status: 503, statusText: 'Unavailable', text: async () => 'Try again' });
  const saved = { 'role-public': true, private: true };
  const view = await mount({ initialValue: saved });
  await settle();
  assert.equal(view.changes.length, 0);
  assert.match(view.element.textContent, /Could not load communication preferences/);
  request = success;
  await act(async () => view.element.querySelector('[role="alert"] button').click());
  await settle();
  assert.deepEqual(view.changes, [{ 'role-public': true }]);
  await view.cleanup();
});

test('unresolved and failed member eligibility retain values until retry succeeds', async () => {
  request = success;
  const saved = { 'role-public': true, private: true };
  let retryCount = 0;
  const view = await mount({
    initialValue: saved,
    rendererProps: { communicationMemberContext: true, communicationEligibilityReady: false },
  });
  await settle();
  assert.equal(view.changes.length, 0);
  await view.render({
    communicationMemberContext: true,
    communicationEligibilityReady: false,
    communicationEligibilityError: { message: 'Member unavailable', retry: () => { retryCount += 1; } },
  });
  assert.equal(view.changes.length, 0);
  assert.match(view.element.textContent, /Member unavailable/);
  await act(async () => view.element.querySelector('[role="alert"] button').click());
  assert.equal(retryCount, 1);
  await view.render({ communicationMemberContext: true, communicationEligibilityReady: true });
  assert.deepEqual(view.changes, [{ private: true }]);
  await view.cleanup();
});