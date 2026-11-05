import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

// Mount the actual component with controlled boundary hooks and renderers.
// No external services or real tenant/session transport are involved.
const source = readFileSync(new URL('./HomePageRedirect.jsx', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '')
  .replace('export default function HomePageRedirect', 'function HomePageRedirect');
const code = transformSync(`${source}\nmodule.exports = HomePageRedirect;`, {
  loader: 'jsx', jsx: 'transform', format: 'cjs',
}).code;

test('successful early home discovery cannot mask a later branding failure', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://tenant.example.test/' });
  const previous = { window: globalThis.window, document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let branding = { branding: null, loading: true, error: null, tenantSlug: 'tenant' };
  let decision;
  const requests = [];
  const exports = { exports: {} };
  const unexpectedRenderer = () => { throw new Error('No destination content may render'); };
  vm.runInNewContext(code, {
    module: exports, React, useRef: React.useRef, useEffect: React.useEffect, popupDiagnostic: () => {}, useQuery, window: dom.window,
    URLSearchParams,
    useLocation: () => ({ search: '' }),
    useMemberAccess: () => ({ authResolved: true, sessionValidated: false, memberInfo: null }),
    useTenantBranding: () => branding,
    usePageLayoutDecision: value => { decision = value; },
    IEditElementRenderer: unexpectedRenderer, CanvasPageRenderer: unexpectedRenderer,
    StaticHtmlPageRenderer: unexpectedRenderer, Events: unexpectedRenderer,
    fetch: async url => {
      requests.push(url);
      assert.equal(url, '/api/public/portal-branding');
      return { ok: true, json: async () => ({ homePageSlug: 'welcome' }) };
    },
  });
  const Component = exports.exports;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  const render = () => root.render(<QueryClientProvider client={queryClient}><Component /></QueryClientProvider>);
  try {
    await act(async () => { render(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.deepEqual(requests, ['/api/public/portal-branding']);
    assert.ok(container.querySelector('[data-testid="loading-home-page"]'));
    assert.equal(decision, null);
    branding = { ...branding, loading: false, error: new Error('Branding unavailable') };
    await act(async () => { render(); });
    assert.match(container.querySelector('[role="alert"]')?.textContent || '', /Homepage unavailable/);
    assert.equal(container.querySelector('[data-testid="loading-home-page"]'), null);
    assert.equal(container.querySelector('header,footer'), null);
    assert.equal(decision.publicChrome, 'none');
    assert.deepEqual(requests, ['/api/public/portal-branding'], 'disabled page transport never starts');
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('homepage starts popup discovery alongside the page request but cannot render it before page validation', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://tenant.example.test/' });
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  const rendered = [];
  const discovery = { pageSlug: 'welcome', viewerIdentity: 'member:member-fixture', promise: Promise.resolve(null) };
  let releasePage;
  const pageResponse = new Promise(resolve => { releasePage = resolve; });
  const exports = { exports: {} };
  vm.runInNewContext(code, {
    module: exports, React, useRef: React.useRef, useEffect: React.useEffect, popupDiagnostic: () => {}, useQuery, window: dom.window, URLSearchParams,
    useLocation: () => ({ search: '' }),
    useMemberAccess: () => ({ authResolved: true, sessionValidated: true, isAccessReady: true, memberInfo: { id: 'member-fixture' } }),
    useTenantBranding: () => ({ branding: { id: 'tenant-fixture' }, loading: false, error: null, tenantSlug: 'tenant' }),
    usePageLayoutDecision: () => {},
    startPopupDiscovery: (slug, viewer, signal) => {
      assert.equal(slug, 'welcome');
      assert.equal(viewer, 'member:member-fixture');
      assert.equal(signal.aborted, false);
      requests.push('popup-discovery');
      return discovery;
    },
    PopupRuntime: props => { rendered.push(props); return null; },
    IEditElementRenderer: () => null, CanvasPageRenderer: () => null,
    StaticHtmlPageRenderer: () => null, Events: () => null,
    fetch: async url => {
      requests.push(url);
      if (url === '/api/public/portal-branding') return { ok: true, json: async () => ({ homePageSlug: 'welcome' }) };
      assert.equal(url, '/api/public/page/welcome');
      return pageResponse;
    },
  });
  const Component = exports.exports;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><Component /></QueryClientProvider>));
    for (let n = 0; n < 10 && requests.length < 3; n++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    assert.deepEqual(requests, ['/api/public/portal-branding', 'popup-discovery', '/api/public/page/welcome']);
    assert.equal(rendered.length, 0, 'loading the page is not display authority');
    releasePage({ ok: true, json: async () => ({ success: true, page: {
      id: 'page-fixture', slug: 'welcome', status: 'published', builder_type: 'canvas',
    } }) });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.ok(rendered.length > 0);
    assert.equal(rendered.at(-1).initialDiscovery, discovery);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
