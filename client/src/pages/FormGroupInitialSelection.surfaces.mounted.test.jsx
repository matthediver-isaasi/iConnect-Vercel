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
  CustomEvent: window.CustomEvent, HTMLInputElement: window.HTMLInputElement,
  NodeFilter: window.NodeFilter,
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
      "export { default as FloaterDisplay } from './client/src/components/floaters/FloaterDisplay.jsx';",
      "export { default as FormSettings } from './client/src/pages/FormSettings.jsx';",
      "export { toast } from 'sonner';",
      "export { supabase } from './client/src/api/supabaseClient.js';",
      "export { default as LayoutContext } from './client/src/contexts/LayoutContext.jsx';",
      "export { publicClient } from './client/src/api/publicClient.js';",
      "export { base44 } from './client/src/api/base44Client.js';",
      "export { setActiveTenantId } from './client/src/api/base44Client.js';",
      "export { MemoryRouter, Route, Routes } from 'react-router-dom';",
      "export { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
    ].join('\n'),
    resolveDir: process.cwd(), loader: 'js',
  },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, logLevel: 'silent',
  plugins: [{ name: 'ignore-package-css', setup(build) {
    build.onLoad({ filter: /\/api\/supabaseClient\.js$/ }, () => ({
      contents: 'export const supabase = { from() { throw new Error("Unexpected Supabase request"); } }; export const isSupabaseConfigured = true;',
      loader: 'js',
    }));
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

for (const surface of ['view', 'embed', 'iedit']) {
  for (const layout of ['standard', 'card_swipe']) {
    test(`${surface} ${layout} shows privacy link only at final step and preserves answers on click`, async () => {
      publicClient.getFormConsentMessage = async () => ({ message: 'Consent text', privacy_settings_url: 'https://example.com/privacy' });
      const definition = form(layout);
      definition.pages.push({ id: 'last', title: 'Last page' });
      definition.fields.push({ id: 'last', type: 'text', label: 'Last answer', page_id: 'last' });
      const view = await mount(surface, definition);
      try {
        assert.equal(view.element.querySelector('[data-testid="link-privacy-settings"]'), null);
        const next = [...view.element.querySelectorAll('button')].find(button => button.textContent.trim() === 'Next');
        assert.ok(next, view.element.textContent);
        await act(async () => next.click()); await settle();
        const link = view.element.querySelector('[data-testid="link-privacy-settings"]');
        assert.ok(link, view.element.textContent);
        assert.equal(link.textContent.trim(), 'Privacy Settings');
        assert.equal(link.target, '_blank');
        assert.equal(link.rel, 'noopener noreferrer');
        assert.equal(link.parentElement.previousElementSibling.textContent, 'Consent text');
        const input = view.element.querySelector('input[type="text"]');
        assert.ok(input);
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'Unfinished answer');
          input.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
        let submissions = 0;
        view.element.addEventListener('submit', () => submissions++);
        link.focus();
        assert.equal(document.activeElement, link);
        // Prevent JSDOM's unimplemented navigation, after observing the native anchor.
        link.addEventListener('click', event => event.preventDefault(), { once: true });
        await act(async () => link.click()); await settle();
        assert.equal(input.value, 'Unfinished answer');
        assert.equal(submissions, 0);
      } finally {
        await view.cleanup();
        publicClient.getFormConsentMessage = async () => ({ message: '' });
      }
    });
  }
  test(`${surface} URL-only, legacy, blank and unsafe configurations render defensively`, async () => {
    for (const config of [
      { message: '', privacy_settings_url: 'https://example.com/privacy' },
      { message: 'Legacy only' },
      { message: '' },
      { message: '', privacy_settings_url: 'javascript:alert(1)' },
    ]) {
      publicClient.getFormConsentMessage = async () => config;
      const view = await mount(surface, form('standard'));
      try {
        assert.equal(!!view.element.querySelector('[data-testid="link-privacy-settings"]'), config.privacy_settings_url === 'https://example.com/privacy');
        assert.equal(!!view.element.querySelector('[data-testid="text-consent-message"]'), !!config.message);
      } finally { await view.cleanup(); }
    }
    publicClient.getFormConsentMessage = async () => ({ message: '' });
  });
}

for (const layout of ['standard', 'card_swipe']) {
  test(`pop-up ${layout} renders the shared consent link without closing or submitting`, async () => {
    const { FloaterDisplay, supabase } = module.exports;
    const originalFrom = supabase.from;
    const definition = form(layout);
    const client = new QueryClient({ defaultOptions: {
      queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity },
    } });
    const element = document.createElement('div'); document.body.appendChild(element);
    const root = createRoot(element);
    supabase.from = table => {
      const query = {
        select() { return this; }, eq() { return this; }, or() { return this; }, order() { return this; },
        update() { return this; },
        then(resolve) { return Promise.resolve({ data: table === 'form' ? [definition] : [{
          id: 'floater', name: 'Open privacy form', is_active: true, action_type: 'form', form_slug: 'groups',
          display_location: 'both', image_url: '/test.png',
        }], error: null }).then(resolve); },
      }; return query;
    };
    publicClient.getFormConsentMessage = async () => ({ message: '', privacy_settings_url: 'https://example.com/privacy' });
    try {
      await act(async () => root.render(h(QueryClientProvider, { client },
        h(FloaterDisplay, { memberInfo: { tenant_id: 'test-tenant' }, authResolved: true }))));
      await settle();
      await act(async () => element.querySelector('img').click()); await settle();
      const link = document.querySelector('[data-testid="link-privacy-settings"]');
      assert.ok(link, document.body.textContent);
      assert.equal(link.target, '_blank');
      let submitted = false;
      document.querySelector('form')?.addEventListener('submit', () => { submitted = true; });
      link.addEventListener('click', event => event.preventDefault(), { once: true });
      await act(async () => link.click()); await settle();
      assert.equal(submitted, false);
      assert.ok(document.querySelector('[data-testid="link-privacy-settings"]'));
    } finally {
      await act(async () => root.unmount()); client.clear(); element.remove();
      supabase.from = originalFrom;
      publicClient.getFormConsentMessage = async () => ({ message: '' });
    }
  });
}

test('Form Settings saves, reloads, changes, clears and reports URL failures without success', async () => {
  const { FormSettings, toast } = module.exports;
  let rows = [{ id: 'legacy', setting_key: 'form_default_consent_message', setting_value: 'Legacy consent' }];
  const originalSave = publicClient.saveFormPrivacySettingsUrl;
  const originalSuccess = toast.success, originalError = toast.error;
  const originalSettings = { ...base44.entities.SystemSettings };
  const originalRoles = base44.entities.Role.list, originalForms = base44.entities.Form.list;
  const success = [], errors = [];
  let failSave = false;
  toast.success = message => success.push(message);
  toast.error = message => errors.push(message);
  base44.entities.Role.list = async () => [];
  base44.entities.Form.list = async () => [];
  base44.entities.SystemSettings.list = async () => rows.map(row => ({ ...row }));
  base44.entities.SystemSettings.update = async (id, patch) => {
    const row = rows.find(row => row.id === id); Object.assign(row, patch); return { ...row };
  };
  publicClient.saveFormPrivacySettingsUrl = async value => {
    if (failSave) throw new Error('Save unavailable');
    rows = rows.filter(row => row.setting_key !== 'form_privacy_settings_url');
    rows.push({ id: 'url', setting_key: 'form_privacy_settings_url', setting_value: value });
    return { privacy_settings_url: value };
  };
  let client, element, root;
  const cleanup = async () => {
    if (root) await act(async () => root.unmount());
    client?.clear(); element?.remove(); root = null;
  };
  const mountSettings = async () => {
    client = new QueryClient({ defaultOptions: {
      queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity },
    } });
    element = document.createElement('div'); document.body.appendChild(element); root = createRoot(element);
    await act(async () => root.render(h(QueryClientProvider, { client },
      h(LayoutContext.Provider, { value: { authResolved: true, memberInfo: null, sessionValidated: false } }, h(FormSettings)))));
    await settle();
  };
  const setUrl = async value => {
    const input = element.querySelector('#privacy-settings-url'); assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const save = async () => {
    await act(async () => element.querySelector('[data-testid="button-save-settings"]').click());
    await settle();
  };
  try {
    await mountSettings();
    assert.equal(element.querySelector('#consent-message').value, 'Legacy consent');
    assert.equal(element.querySelector('#privacy-settings-url').value, '');
    for (const value of [' https://example.com/privacy ', 'https://example.com/changed', '']) {
      const invalidations = [];
      const originalInvalidate = client.invalidateQueries.bind(client);
      client.invalidateQueries = options => { invalidations.push(options.queryKey); return originalInvalidate(options); };
      await setUrl(value); await save();
      assert.ok(invalidations.some(key => key[0] === 'formDefaultConsentMessage'));
      await cleanup(); await mountSettings();
      assert.equal(element.querySelector('#privacy-settings-url').value, value.trim());
      assert.equal(element.querySelector('#consent-message').value, 'Legacy consent');
    }
    const successes = success.length;
    await setUrl('javascript:alert(1)'); await save();
    assert.equal(success.length, successes);
    assert.match(errors.at(-1), /valid HTTP/);
    failSave = true; await setUrl('https://example.com/unavailable'); await save();
    assert.equal(success.length, successes);
    assert.equal(errors.at(-1), 'Save unavailable');
    assert.equal(element.querySelector('#privacy-settings-url').value, 'https://example.com/unavailable');
  } finally {
    await cleanup();
    publicClient.saveFormPrivacySettingsUrl = originalSave;
    Object.assign(base44.entities.SystemSettings, originalSettings);
    base44.entities.Role.list = originalRoles; base44.entities.Form.list = originalForms;
    toast.success = originalSuccess; toast.error = originalError;
  }
});

test('privacy setting writes send the displayed tenant rather than public tenant discovery', async () => {
  const previousFetch = globalThis.fetch;
  module.exports.setActiveTenantId('tenant-a');
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, json: async () => ({ privacy_settings_url: '' }) };
  };
  try {
    await publicClient.saveFormPrivacySettingsUrl('');
    assert.equal(captured.options.headers.get('X-Tenant-Id'), 'tenant-a');
    assert.equal(captured.options.credentials, 'include');
    assert.equal(captured.url, '/api/public/form-consent-message');
  } finally {
    globalThis.fetch = previousFetch;
    module.exports.setActiveTenantId(null);
  }
});