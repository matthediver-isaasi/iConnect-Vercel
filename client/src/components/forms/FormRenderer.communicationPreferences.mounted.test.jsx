import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { formCommunicationRoleSourceAnswers } from '../../lib/formCommunicationCategoryEligibility.js';

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
globalThis.fetch = async (url, options) => {
  return request(url, options);
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
const memberCategories = [
  { id: 'private', name: 'Private', description: 'Member preference' },
  { id: 'member', name: 'Member scoped', description: 'For graduates' },
];

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
  request = url => {
    assert.match(url, /\/api\/public\/communication-categories/);
    return success();
  };
  const view = await mount();
  await settle();
  assert.ok(view.element.querySelector('[data-testid="comm-pref-category-role-public"]'));
  assert.equal(view.element.querySelector('[data-testid="comm-pref-category-private"]'), null);
  assert.deepEqual(view.changes[0], { 'role-public': true, member: false });
  await view.cleanup();
});

test('roleless creation is member context, and existing member role takes precedence', async () => {
  request = url => {
    assert.match(url, /\/api\/public\/communication-categories/);
    return success();
  };
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
  request = url => {
    assert.match(url, /\/api\/public\/communication-categories/);
    return { ok: false, status: 503, statusText: 'Unavailable', text: async () => 'Try again' };
  };
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
  await settle();
  assert.deepEqual(view.changes, [{ private: true }]);
  await view.cleanup();
});

test('existing member uses form-scoped endpoint, server eligibility, field allowlist and defaults', async () => {
  const calls = [];
  request = (url, options) => {
    calls.push({ url, options });
    assert.match(url, /\/api\/public\/form\/communication-categories/);
    return { ok: true, json: async () => memberCategories };
  };
  const view = await mount({
    rendererProps: {
      formId: 'form-a',
      memberInfo: { id: 'viewer', role_id: 'other' },
      communicationAccess: {
        memberId: 'target', sessionMemberId: 'viewer',
        applicantContinuationToken: 'private-grant', draftToken: 'private-draft',
      },
      field: { id: 'preferences', type: 'communication_preferences',
        allowed_category_ids: ['private'], default_selected_category_ids: ['private'] },
    },
  });
  await settle();
  assert.ok(view.element.querySelector('[data-testid="comm-pref-category-private"]'));
  assert.equal(view.element.querySelector('[data-testid="comm-pref-category-member"]'), null);
  assert.deepEqual(view.changes, [{ private: true }]);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'include');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    formId: 'form-a', fieldId: 'preferences', memberId: 'target',
    applicantContinuationToken: 'private-grant', draftToken: 'private-draft',
  });
  assert.ok(!view.element.textContent.includes('private-grant'));
  await view.cleanup();
});

test('existing member category failure preserves selections until retry and successful reconciliation', async () => {
  let fail = true;
  request = url => {
    assert.match(url, /\/api\/public\/form\/communication-categories/);
    return fail
      ? { ok: false, status: 403, statusText: 'Forbidden', text: async () => 'Not authorized' }
      : { ok: true, json: async () => memberCategories };
  };
  const view = await mount({
    initialValue: { private: true, 'role-public': true },
    rendererProps: { formId: 'form-a', communicationAccess: { memberId: 'target' } },
  });
  await settle();
  assert.equal(view.changes.length, 0);
  assert.match(view.element.textContent, /Could not load communication preferences/);
  fail = false;
  await act(async () => view.element.querySelector('[role="alert"] button').click());
  await settle();
  assert.deepEqual(view.changes, [{ private: true }]);
  await view.cleanup();
});

test('public member creation discovers private eligible categories and initializes defaults without sending a role', async () => {
  const calls = [];
  request = (url, options) => {
    calls.push({ url, options });
    assert.match(url, /\/api\/public\/form\/communication-categories/);
    return { ok: true, json: async () => memberCategories };
  };
  const view = await mount({
    rendererProps: {
      formId: 'joining-form',
      communicationMemberContext: true,
      communicationAccess: { createsMember: true, sourceAnswers: { audience: 'graduate' } },
      field: { id: 'preferences', type: 'communication_preferences',
        default_selected_category_ids: ['private'] },
    },
  });
  await settle();
  assert.ok(view.element.querySelector('[data-testid="comm-pref-category-private"]'));
  assert.deepEqual(view.changes[0], { private: true, member: false });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    formId: 'joining-form', fieldId: 'preferences', sourceAnswers: { audience: 'graduate' },
  });
  assert.equal(calls[0].options.credentials, 'include');
  await view.cleanup();
});

test('member creation request failure retains answers and retries before filtering them', async () => {
  let fail = true;
  request = url => {
    assert.match(url, /\/api\/public\/form\/communication-categories/);
    return fail
      ? { ok: false, status: 503, statusText: 'Unavailable', text: async () => 'Try again' }
      : { ok: true, json: async () => memberCategories };
  };
  const view = await mount({
    initialValue: { private: true, 'role-public': true },
    rendererProps: { formId: 'joining-form', communicationAccess: { createsMember: true } },
  });
  await settle();
  assert.deepEqual(view.changes, []);
  assert.match(view.element.textContent, /Could not load communication preferences/);
  fail = false;
  await act(async () => view.element.querySelector('[role="alert"] button').click());
  await settle();
  assert.deepEqual(view.changes, [{ private: true }]);
  await view.cleanup();
});

test('member creation role answer changes refresh eligible categories before reconciling saved answers', async () => {
  const calls = [];
  let resolveChanged;
  request = (url, options) => {
    assert.match(url, /\/api\/public\/form\/communication-categories/);
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.sourceAnswers?.audience === 'student') {
      return new Promise(resolve => { resolveChanged = resolve; });
    }
    return { ok: true, json: async () => memberCategories };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { formId: 'joining-form', communicationAccess: {
    createsMember: true, sourceAnswers: { audience: 'graduate' },
  } };
  const view = await mount({ queryClient, initialValue: { private: true }, rendererProps: props });
  await settle();
  await view.render({ ...props, communicationAccess: {
    createsMember: true, sourceAnswers: { audience: 'student' },
  } });
  assert.equal(view.changes.length, 0);
  assert.match(view.element.textContent, /Loading communication preferences/);
  assert.ok(!JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.queryKey)).includes('student'));
  await act(async () => resolveChanged({
    ok: true, json: async () => [{ id: 'member', name: 'Student category' }],
  }));
  await settle();
  assert.deepEqual(view.changes, [{}]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].sourceAnswers, { audience: 'student' });
  await view.cleanup();
});

test('conditional set_role and clear_role source changes refresh private category eligibility', async () => {
  const roleForm = {
    fields: [{ id: 'region' }, { id: 'plan' }, { id: 'unrelated' }],
    entity_pipelines: { members: [{ isPrimary: true }] },
    visibility_rules: [
      { conditions: [{ field_id: 'region' }, { field_id: 'plan' }],
        actions: [{ action_type: 'set_role', role_id: 'server-only-role' }] },
      { trigger_field_id: 'plan', actions: [{ action_type: 'clear_role' }] },
    ],
  };
  const calls = [];
  request = (url, options) => {
    assert.match(url, /\/api\/public\/form\/communication-categories/);
    const body = JSON.parse(options.body);
    calls.push(body);
    return { ok: true, json: async () => body.sourceAnswers?.region === 'North'
      ? memberCategories : [{ id: 'member', name: 'General preference' }] };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = answers => ({
    formId: 'joining-form',
    communicationAccess: {
      createsMember: true,
      sourceAnswers: formCommunicationRoleSourceAnswers(roleForm, answers),
    },
  });
  const view = await mount({
    queryClient, initialValue: { private: true },
    rendererProps: props({ region: 'North', plan: 'full', unrelated: 'secret' }),
  });
  await settle();
  assert.ok(view.element.querySelector('[data-testid="comm-pref-category-private"]'));
  await view.render(props({ region: 'South', plan: 'full', unrelated: 'changed' }));
  await settle();
  assert.equal(view.element.querySelector('[data-testid="comm-pref-category-private"]'), null);
  assert.deepEqual(view.changes, [{}]);
  await view.render(props({ region: 'South', plan: 'basic', unrelated: 'changed' }));
  await settle();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].sourceAnswers, { region: 'North', plan: 'full' });
  assert.deepEqual(calls[2].sourceAnswers, { region: 'South', plan: 'basic' });
  assert.ok(!JSON.stringify(calls).includes('server-only-role'));
  assert.ok(!JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.queryKey)).includes('South'));
  await view.cleanup();
});

test('non-member form remains public; switching target and credentials refetches without exposing tokens in query keys', async () => {
  const calls = [];
  request = (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.includes('/form/') ? memberCategories : categories };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await mount({ queryClient, rendererProps: { formId: 'form-a', communicationMemberContext: true } });
  await settle();
  assert.match(calls[0].url, /\/api\/public\/communication-categories/);
  await view.render({ formId: 'form-a', communicationAccess: { memberId: 'target-a', draftToken: 'secret-one' } });
  await settle();
  await view.render({ formId: 'form-a', communicationAccess: { memberId: 'target-b', draftToken: 'secret-two' } });
  await settle();
  assert.equal(calls.filter(call => call.url.includes('/form/')).length, 2);
  assert.ok(!JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.queryKey)).includes('secret-'));
  await view.cleanup();
});