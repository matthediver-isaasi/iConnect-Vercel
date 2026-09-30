import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import Module from 'node:module';
import { build } from 'esbuild';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/embed/form/join',
  pretendToBeVisual: true,
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  location: window.location,
  history: window.history,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  DocumentFragment: window.DocumentFragment,
  Node: window.Node,
  Event: window.Event,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});
window.ResizeObserver = globalThis.ResizeObserver;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const bundle = await build({
  stdin: {
    contents: "export { default as EmbedFormPage } from './client/src/pages/EmbedForm.jsx'; export { publicClient } from './client/src/api/publicClient.js'; export { MemoryRouter, Route, Routes } from 'react-router-dom'; export { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const bundledModule = new Module(`${process.cwd()}/embed-form-communication-test-memory.cjs`);
bundledModule.filename = `${process.cwd()}/embed-form-communication-test-memory.cjs`;
bundledModule.paths = Module._nodeModulePaths(process.cwd());
bundledModule._compile(bundle.outputFiles[0].text, bundledModule.filename);
const { EmbedFormPage, publicClient, MemoryRouter, Route, Routes, QueryClient, QueryClientProvider } = bundledModule.exports;
const h = React.createElement;

const originalGetForm = publicClient.getForm;
const originalCategories = publicClient.listFormCommunicationCategories;
const originalPublicCategories = publicClient.listCommunicationCategories;
const originalFetch = globalThis.fetch;
let member = null;
globalThis.fetch = async url => {
  if (url === '/api/auth/me') {
    return member
      ? { ok: true, json: async () => member }
      : { ok: false, status: 401, json: async () => ({}) };
  }
  throw new Error(`Unexpected request ${url}`);
};
after(() => {
  publicClient.getForm = originalGetForm;
  publicClient.listFormCommunicationCategories = originalCategories;
  publicClient.listCommunicationCategories = originalPublicCategories;
  globalThis.fetch = originalFetch;
  dom.window.close();
});

const preferenceField = (extra = {}) => ({
  id: 'preferences',
  type: 'communication_preferences',
  label: 'Newsletter preferences',
  default_selected_category_ids: ['private'],
  ...extra,
});
const privateCategory = { id: 'private', name: 'Members newsletter', description: 'For members' };
const page = { id: 'join-page', title: 'Join' };
function joiningForm(layout, { repeatable = false } = {}) {
  return {
    id: `join-${layout}-${repeatable ? 'rows' : 'simple'}`,
    slug: 'join',
    name: 'Join',
    layout_type: layout,
    is_active: true,
    prefill_source: 'none',
    pages: layout === 'standard' ? [page] : [],
    entity_pipelines: { members: [{ isPrimary: true, role_id: 'new-member-role' }] },
    fields: repeatable
      ? [{
          id: 'rows',
          type: 'repeatable_rows',
          label: 'Rows',
          min_rows: 1,
          default_value: [{ _row_id: 'row-1' }],
          page_id: page.id,
          children: [preferenceField()],
        }]
      : [preferenceField(layout === 'standard' ? { page_id: page.id } : {})],
  };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
  }
}

async function mount(form, { viewer = null, request } = {}) {
  member = viewer;
  const calls = [];
  publicClient.getForm = async () => form;
  publicClient.listCommunicationCategories = async () => {
    throw new Error('Member form must not use the anonymous category list');
  };
  publicClient.listFormCommunicationCategories = async args => {
    calls.push(args);
    return request ? request(args) : [privateCategory];
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => root.render(h(QueryClientProvider, { client: queryClient },
    h(MemoryRouter, { initialEntries: ['/embed/form/join'] },
      h(Routes, null, h(Route, { path: '/embed/form/:slug', element: h(EmbedFormPage) }))))));
  await settle();
  return {
    element, calls,
    cleanup: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
      element.remove();
    },
  };
}

for (const layout of ['card_swipe', 'standard']) {
  test(`embedded ${layout} member creation renders server-eligible private newsletter and defaults`, async () => {
    const form = joiningForm(layout);
    const view = await mount(form);
    try {
      const checkbox = view.element.querySelector('[data-testid="comm-pref-category-private"] [role="checkbox"]');
      assert.ok(checkbox, view.element.textContent);
      assert.equal(checkbox.getAttribute('data-state'), 'checked');
      assert.equal(view.calls.length, 1);
      assert.equal(view.calls[0].formId, form.id);
      assert.equal(view.calls[0].fieldId, 'preferences');
      assert.equal(view.calls[0].memberId, null);
    } finally {
      await view.cleanup();
    }
  });
}

test('embedded page passes authenticated existing member ID instead of treating viewer as new member', async () => {
  const form = { ...joiningForm('standard'), entity_pipelines: { members: [] } };
  const view = await mount(form, { viewer: { id: 'viewer-1', role_id: 'other' } });
  try {
    assert.ok(view.element.querySelector('[data-testid="comm-pref-category-private"]'));
    assert.equal(view.calls[0].memberId, 'viewer-1');
  } finally {
    await view.cleanup();
  }
});

test('embedded page repeatable preference child receives private categories and initializes defaults', async () => {
  const form = joiningForm('standard', { repeatable: true });
  const view = await mount(form);
  try {
    const checkbox = view.element.querySelector('[data-testid="comm-pref-category-private"] [role="checkbox"]');
    assert.ok(checkbox, view.element.textContent);
    assert.equal(checkbox.getAttribute('data-state'), 'checked');
    assert.ok(view.calls.some(call => call.fieldId === 'preferences' && call.formId === form.id));
  } finally {
    await view.cleanup();
  }
});

test('embedded page refreshes private eligibility when a conditional role answer changes', async () => {
  const form = joiningForm('standard');
  form.fields.unshift({
    id: 'region', type: 'radio', label: 'Region',
    options: ['North', 'South'], default_value: 'North', page_id: page.id,
  });
  form.visibility_rules = [{
    conditions: [{ field_id: 'region', operator: 'equals', value: 'North' }],
    actions: [{ action_type: 'set_role', role_id: 'trusted-role' }],
  }];
  const view = await mount(form, {
    request: ({ sourceAnswers }) => sourceAnswers?.region === 'North' ? [privateCategory] : [],
  });
  try {
    assert.ok(view.calls.some(call => call.sourceAnswers?.region === 'North'));
    assert.ok(view.element.querySelector('[data-testid="comm-pref-category-private"]'));
    const south = view.element.querySelector('#region-1');
    assert.ok(south, view.element.textContent);
    await act(async () => south.click());
    await settle();
    assert.ok(view.calls.some(call => call.sourceAnswers?.region === 'South'));
    assert.equal(view.element.querySelector('[data-testid="comm-pref-category-private"]'), null);
    assert.match(view.element.textContent, /No communication preferences available/);
  } finally {
    await view.cleanup();
  }
});

test('embedded card surfaces member eligibility failure and retries without anonymous fallback', async () => {
  let failed = true;
  const view = await mount(joiningForm('card_swipe'), {
    request: () => {
      if (failed) throw new Error('Member eligibility unavailable');
      return [privateCategory];
    },
  });
  try {
    assert.match(view.element.textContent, /Member eligibility unavailable/);
    assert.equal(view.element.querySelector('[data-testid="comm-pref-category-private"]'), null);
    failed = false;
    await act(async () => view.element.querySelector('[role="alert"] button').click());
    await settle();
    assert.ok(view.element.querySelector('[data-testid="comm-pref-category-private"]'));
  } finally {
    await view.cleanup();
  }
});