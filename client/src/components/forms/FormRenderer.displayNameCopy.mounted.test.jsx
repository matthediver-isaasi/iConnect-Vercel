import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/copy' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event,
  DocumentFragment: dom.window.DocumentFragment,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
window.localStorage.setItem('tenant_slug', 'test-tenant');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: FormRenderer } = await import('./FormRenderer.jsx');

const response = (data) => ({
  ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => data, text: async () => JSON.stringify(data),
});

test('mounted picker reports pending then labels and keeps its same-scope cache across navigation unmount', async () => {
  let release;
  let markFetchStarted;
  const fetchStarted = new Promise(resolve => { markFetchStarted = resolve; });
  globalThis.fetch = async (url) => {
    assert.match(String(url), /organisation-groups/);
    markFetchStarted();
    await new Promise(resolve => { release = resolve; });
    return response([{ id: 'group-a', name: 'Alpha Group' }]);
  };
  const changes = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onState = (_id, state) => changes.push(state);
  const group = { id: 'group', type: 'organisation_group_dropdown', label: 'Group' };
  const allValues = { group: 'group-a', copied: '' };
  try {
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client },
        React.createElement(FormRenderer, {
          field: group, value: 'group-a', allFields: [group], allFormValues: allValues,
          formId: 'form-a', onChange: () => {}, onRecordSelectionOptionsChange: onState,
        })));
    });
    await fetchStarted;
    assert.equal(changes.at(-1)?.status, 'pending');
    await act(async () => {
      release();
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(changes.at(-1)?.status, 'resolved');
    assert.deepEqual(changes.at(-1)?.options, [{ id: 'group-a', label: 'Alpha Group' }]);

    // This is the actual renderer unmount performed by page/card navigation.
    // It must not publish an unavailable state and erase a valid same-scope
    // display-name copy merely because the source is off-screen.
    const countBeforeNavigation = changes.length;
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client },
        React.createElement(FormRenderer, {
          field: { id: 'copied', type: 'text', label: 'Copied' }, value: 'Alpha Group',
          allFields: [group], allFormValues: allValues, formId: 'form-a', onChange: () => {},
          onRecordSelectionOptionsChange: onState,
        })));
    });
    assert.equal(changes.length, countBeforeNavigation);
    assert.equal(changes.at(-1)?.status, 'resolved');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});