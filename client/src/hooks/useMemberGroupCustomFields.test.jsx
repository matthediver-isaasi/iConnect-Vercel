import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.example.test/MemberGroupSettings' });
for (const name of ['window', 'document', 'navigator', 'DocumentFragment', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'CustomEvent', 'MutationObserver', 'getComputedStyle']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { LayoutProvider, useLayoutContext } = await import('../contexts/LayoutContext.jsx');
const { setActiveTenantId } = await import('../api/base44Client.js');
const { useMemberGroupCustomFields } = await import('./useMemberGroupCustomFields.js');
const { default: CustomFieldSettingsCard } = await import('../components/member-groups/CustomFieldSettingsCard.jsx');

const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

test('definition discovery and saves are tenant/auth-session scoped, fail closed, and preserve error drafts', async () => {
  const originalFetch = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const root = createRoot(document.createElement('div'));
  let layout;
  let definitions;
  let failRead = false;
  let failWrite = false;
  let delayedSave;
  const calls = [];
  function Probe() {
    layout = useLayoutContext();
    definitions = useMemberGroupCustomFields();
    return <span>{definitions.ready ? 'ready' : 'blocked'}</span>;
  }
  const authenticate = async (tenantId, memberId, sessionKey) => {
    await act(async () => {
      setActiveTenantId(tenantId);
      layout.setMemberInfo({ tenant_id: tenantId, id: memberId, role_id: `role-${tenantId}` });
      layout.setSessionRoleSnapshot({
        status: 'ready', tenant_id: tenantId, member_id: memberId, role_id: `role-${tenantId}`, session_key: sessionKey,
        role: { id: `role-${tenantId}`, tenant_id: tenantId, excluded_features: [] },
      });
      layout.setAuthResolved(true);
      layout.setSessionValidated(true);
    });
    await settle();
  };
  try {
    globalThis.fetch = async (_url, options) => {
      calls.push(options);
      if ((options.method === 'GET' && failRead) || (options.method === 'PUT' && failWrite)) {
        return new Response(JSON.stringify({ error: 'Revision conflict' }), { status: options.method === 'PUT' ? 409 : 503 });
      }
      if (options.method === 'PUT' && delayedSave) return delayedSave;
      return new Response(JSON.stringify({ fields: [], revision: 3 }));
    };
    await act(async () => root.render(<QueryClientProvider client={client}><LayoutProvider><Probe /></LayoutProvider></QueryClientProvider>));
    assert.equal(calls.length, 0, 'no unvalidated definition reads');
    await authenticate('tenant-a', 'admin-a', 'session-a');
    assert.equal(definitions.ready, true);
    assert.equal(calls[0].headers['X-Tenant-Id'], 'tenant-a');
    assert.equal(calls[0].credentials, 'include');
    const scopeA = definitions.scopeKey;
    const draft = { fields: [], revision: 3, confirmedDeletedIds: ['confirmed-id'] };
    failWrite = true;
    await act(async () => {
      await assert.rejects(definitions.save.mutateAsync(draft), /Revision conflict/);
    });
    assert.deepEqual(draft, { fields: [], revision: 3, confirmedDeletedIds: ['confirmed-id'] });
    assert.deepEqual(JSON.parse(calls.at(-1).body), draft);
    failWrite = false;
    failRead = true;
    await act(async () => { await definitions.refetch(); });
    await settle();
    assert.equal(definitions.ready, false, 'cached definitions are not trusted after failed refresh');
    failRead = false;
    await act(async () => { await definitions.refetch(); });
    await settle();
    assert.equal(definitions.ready, true);

    // A late PUT result must not populate the new tenant's cache.
    let release;
    delayedSave = new Promise((resolve) => { release = resolve; });
    let saving;
    await act(async () => { saving = definitions.save.mutateAsync(draft); });
    await authenticate('tenant-b', 'admin-b', 'session-b');
    const scopeB = definitions.scopeKey;
    assert.notEqual(scopeA, scopeB);
    await act(async () => {
      release(new Response(JSON.stringify({ fields: [{ id: 'private-a' }], revision: 4 })));
      await saving;
    });
    await settle();
    assert.deepEqual(definitions.data.fields, [], 'late private definitions do not enter new tenant cache');
    delayedSave = null;

    const callCount = calls.length;
    await authenticate('tenant-b', 'admin-b', 'session-c');
    assert.notEqual(definitions.scopeKey, scopeB);
    assert.ok(calls.length > callCount, 'a new validated session uses a fresh query key');
    await act(async () => setActiveTenantId('tenant-a'));
    assert.equal(definitions.allowed, false, 'mismatched active tenant fails closed');
    await act(async () => layout.setSessionValidated(false));
    assert.equal(definitions.ready, false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setActiveTenantId(null);
    globalThis.fetch = originalFetch;
  }
});

test('settings save failures keep inline edits; new definitions omit draft IDs and stay unpublished by default', async () => {
  const originalFetch = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let layout;
  let failed = true;
  let putBody;
  const saved = { id: '61a81e4d-6070-4a35-8500-622f6c081ece', name: 'Focus', type: 'text', show_on_detail: false, choices: [] };
  let response = { fields: [saved], revision: 2 };
  function Screen() {
    layout = useLayoutContext();
    return <CustomFieldSettingsCard enabled />;
  }
  const click = async (text) => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
    assert.ok(button, `button ${text} exists`);
    await act(async () => button.click());
    await settle();
  };
  const input = async (element, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  try {
    globalThis.fetch = async (_url, options) => {
      if (options.method === 'PUT') {
        putBody = JSON.parse(options.body);
        if (failed) return new Response(JSON.stringify({ error: 'Validation failed; draft retained' }), { status: 400 });
        response = { fields: putBody.fields.map((field, i) => ({ ...field, id: field.id || `new-server-id-${i}` })), revision: 3 };
      }
      return new Response(JSON.stringify(response));
    };
    await act(async () => root.render(<QueryClientProvider client={client}><LayoutProvider><Screen /></LayoutProvider></QueryClientProvider>));
    await act(async () => {
      setActiveTenantId('tenant-settings');
      layout.setMemberInfo({ tenant_id: 'tenant-settings', id: 'admin-settings', role_id: 'settings-role' });
      layout.setSessionRoleSnapshot({
        status: 'ready', tenant_id: 'tenant-settings', member_id: 'admin-settings', role_id: 'settings-role', session_key: 'settings-session',
        role: { id: 'settings-role', excluded_features: [] },
      });
      layout.setAuthResolved(true);
      layout.setSessionValidated(true);
    });
    await settle();
    await input(container.querySelector('input'), 'Renamed focus');
    await click('Save Custom Fields');
    assert.ok(container.textContent.includes('Validation failed; draft retained'));
    assert.equal(container.querySelector('input').value, 'Renamed focus', 'failed saves do not replace inline edits');
    assert.equal(putBody.fields[0].id, saved.id, 'renaming retains immutable identity');
    await click('Add field');
    await input(container.querySelectorAll('input')[1], 'Regional notes');
    failed = false;
    await click('Save Custom Fields');
    assert.equal(putBody.fields[1].name, 'Regional notes');
    assert.equal(putBody.fields[1].show_on_detail, false);
    assert.equal(Object.hasOwn(putBody.fields[1], 'id'), false);
    assert.deepEqual(putBody.confirmedDeletedIds, []);
    assert.equal(putBody.revision, 2);
    assert.equal(container.querySelectorAll('input')[1].value, 'Regional notes');
    await click('Remove');
    assert.ok(document.body.textContent.includes('Remove this custom field?'));
    assert.equal(container.querySelectorAll('input').length, 2, 'opening confirmation has not deleted the field');
    await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Confirm removal').click());
    await settle();
    assert.equal(container.querySelectorAll('input').length, 1);
    await click('Save Custom Fields');
    assert.deepEqual(putBody.confirmedDeletedIds, [saved.id]);
    assert.equal(putBody.fields.length, 1);
    assert.equal(putBody.revision, 3);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    setActiveTenantId(null);
    globalThis.fetch = originalFetch;
  }
});
