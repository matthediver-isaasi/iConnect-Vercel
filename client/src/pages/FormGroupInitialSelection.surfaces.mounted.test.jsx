import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import Module from 'node:module';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/groups', pretendToBeVisual: true });
const { window } = dom;
Object.assign(globalThis, {
  window, document: window.document, navigator: window.navigator,
  localStorage: window.localStorage, sessionStorage: window.sessionStorage,
  location: window.location, history: window.history, HTMLElement: window.HTMLElement,
  Element: window.Element, Node: window.Node, Event: window.Event,
  DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
  Text: window.Text, getComputedStyle: window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
window.ResizeObserver = globalThis.ResizeObserver;
window.localStorage.setItem('tenant_slug', 'test-tenant');
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
document.execCommand = () => false;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const bundle = await build({
  stdin: {
    contents: [
      "export { default as FormView } from './client/src/pages/FormView.jsx';",
      "export { default as EmbedForm } from './client/src/pages/EmbedForm.jsx';",
      "export { default as IEditForm } from './client/src/components/iedit/elements/IEditFormElement.jsx';",
      "export { default as LayoutContext } from './client/src/contexts/LayoutContext.jsx';",
      "export { publicClient } from './client/src/api/publicClient.js';",
      "export { base44 } from './client/src/api/base44Client.js';",
      "export { MemoryRouter, Route, Routes } from 'react-router-dom';",
      "export { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
    ].join('\n'),
    resolveDir: process.cwd(), loader: 'js',
  },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, logLevel: 'silent',
  plugins: [{ name: 'ignore-package-css', setup(build) {
    build.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'empty-css' }));
    build.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'js' }));
  } }],
});
const module = new Module(`${process.cwd()}/group-initial-surfaces-test.cjs`);
module.filename = `${process.cwd()}/group-initial-surfaces-test.cjs`;
module.paths = Module._nodeModulePaths(process.cwd());
module._compile(bundle.outputFiles[0].text, module.filename);
const { FormView, EmbedForm, IEditForm, LayoutContext, publicClient, base44, MemoryRouter, Route, Routes, QueryClient, QueryClientProvider } = module.exports;
const h = React.createElement;
const groupA = '10000000-0000-4000-8000-000000000001';
const groupB = '10000000-0000-4000-8000-000000000002';
const originalFetch = globalThis.fetch;
let authViewer = null;
globalThis.fetch = async url => {
  if (url === '/api/auth/me') return { ok: !!authViewer, status: authViewer ? 200 : 401, json: async () => authViewer || {} };
  throw new Error(`Unexpected test network request: ${url}`);
};
publicClient.getFormConsentMessage = async () => ({ message: '' });
publicClient.listFormOrganisationGroupOptions = async () => [{ id: groupA, name: 'Group A' }, { id: groupB, name: 'Group B' }];
base44.entities.MemberPreferenceValue.list = async () => [];
base44.entities.MemberResourceCategory.list = async () => [];
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
async function settle() { for (let i = 0; i < 12; i++) await act(async () => new Promise(resolve => setTimeout(resolve, 5))); }

function form(layout, prefill = 'none') {
  return {
    id: `form-${layout}`, slug: 'groups', name: 'Groups', is_active: true,
    layout_type: layout, prefill_source: prefill, pages: [{ id: 'page', title: 'Details' }],
    entity_pipelines: {},
    fields: [{ id: 'group', type: 'organisation_group_dropdown', label: 'Group', page_id: 'page',
      group_initial_selection: { mode: 'specific', group_id: groupA } }],
  };
}

async function mount(surface, definition, { viewer = null, search = '', authResolved = true } = {}) {
  authViewer = viewer;
  window.history.replaceState({}, '', `/forms/groups${search}`);
  publicClient.getForm = async () => definition;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: Infinity } } });
  const element = document.createElement('div'); document.body.appendChild(element); const root = createRoot(element);
  let resolved = authResolved;
  const render = async () => {
    const route = surface === 'embed' ? '/embed/form/groups' : '/forms/groups';
    const content = surface === 'embed'
      ? h(Routes, null, h(Route, { path: '/embed/form/:slug', element: h(EmbedForm) }))
      : surface === 'view' ? h(FormView, { slug: 'groups' })
        : h(IEditForm, { element: { content: { form_slug: 'groups' } }, memberInfo: viewer });
    await act(async () => root.render(h(QueryClientProvider, { client },
      h(LayoutContext.Provider, { value: {
        authResolved: resolved, sessionValidated: false, memberInfo: viewer, organizationInfo: null,
        setForceBlankLayout() {}, setMemberInfo() {}, setOrganizationInfo() {},
      } }, h(MemoryRouter, { initialEntries: [route + search] }, content)))));
    await settle();
  };
  await render();
  return { element, client, resolveAuth: async () => { resolved = true; await render(); }, cleanup: async () => {
    await act(async () => root.unmount()); client.clear(); element.remove();
  } };
}

for (const surface of ['view', 'embed', 'iedit']) {
  for (const layout of ['standard', 'card_swipe']) {
    test(`${surface} ${layout} applies a tenant-allowed initial group after surface initialization`, async () => {
      const view = await mount(surface, form(layout));
      try {
        const trigger = view.element.querySelector('[data-testid="select-organisation-group-group"]');
        assert.ok(trigger, view.element.textContent);
        assert.match(trigger.textContent, /Group A/);
      } finally { await view.cleanup(); }
    });
  }

  test(`${surface} authenticated prefill remains authoritative while it is pending`, async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    base44.entities.Member.get = async () => pending;
    const viewer = { id: 'member', first_name: 'Member' };
    const view = await mount(surface, form('standard', 'member'), { viewer });
    try {
      const trigger = view.element.querySelector('[data-testid="select-organisation-group-group"]');
      assert.ok(!trigger?.textContent.includes('Group A'), view.element.textContent);
      await act(async () => release({ ...viewer, organization_group_id: groupB }));
      await settle();
      assert.match(view.element.querySelector('[data-testid="select-organisation-group-group"]')?.textContent || '', /Group B/);
    } finally { await view.cleanup(); }
  });

  test(`${surface} URL initialization reads group_id on the running form URL`, async () => {
    const definition = form('standard');
    definition.fields[0].group_initial_selection = { mode: 'url' };
    const view = await mount(surface, definition, { search: `?group_id=${groupB}` });
    try {
      assert.match(view.element.querySelector('[data-testid="select-organisation-group-group"]')?.textContent || '', /Group B/);
    } finally { await view.cleanup(); }
  });
}

test('IEdit waits for the shared auth probe even if its public form and group options load first', async () => {
  const view = await mount('iedit', form('standard'), { authResolved: false });
  try {
    assert.doesNotMatch(view.element.querySelector('[data-testid="select-organisation-group-group"]')?.textContent || '', /Group A/);
    await view.resolveAuth();
    assert.match(view.element.querySelector('[data-testid="select-organisation-group-group"]')?.textContent || '', /Group A/);
  } finally { await view.cleanup(); }
});

for (const surface of ['view', 'iedit']) {
  test(`${surface} restores a draft's intentional blank before considering initial selection`, async () => {
    let release;
    publicClient.getFormDraft = () => new Promise(resolve => { release = resolve; });
    const view = await mount(surface, form('standard'), { search: '?draft=saved' });
    try {
      assert.doesNotMatch(view.element.querySelector('[data-testid="select-organisation-group-group"]')?.textContent || '', /Group A/);
      await act(async () => release({ success: true, draft: { draft_data: { group: '' } } }));
      await settle();
      assert.doesNotMatch(view.element.querySelector('[data-testid="select-organisation-group-group"]')?.textContent || '', /Group A/);
    } finally { await view.cleanup(); }
  });
}