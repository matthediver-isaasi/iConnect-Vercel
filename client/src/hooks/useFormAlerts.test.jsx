import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent'])
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { LayoutProvider, useLayoutContext } = await import('../contexts/LayoutContext.jsx');
const { useFormAlertTenant, useFormAlerts, useRevokeFormAlert } = await import('./useFormAlerts.js');
const { setActiveTenantId } = await import('../api/base44Client.js');
const { invalidateViewerProtectedWork, setViewerProtectedWorkPaused } = await import('../lib/viewerProtectedWorkGate.js');
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

test('verified session scopes reject unknown identity, stale writes, ABA tenant switches and revoked work', async () => {
  const original = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const root = createRoot(document.createElement('div'));
  let layout, context, alerts, revoke, release;
  let writes = 0;
  const headers = [];
  globalThis.fetch = async (url, options) => {
    headers.push(new Headers(options.headers).get('X-Tenant-Id'));
    if (url.includes('tenant-user-me')) return Response.json({ authenticated: true, tenant: { id: 'tenant-a' }, user: { id: 'dashboard-user' } });
    if (options.method === 'PUT') {
      writes++;
      await new Promise(resolve => { release = resolve; });
    }
    return Response.json(options.method === 'POST' ? { revoked: true }
      : { enabled: false, recipients: [], available: true });
  };
  function Probe() {
    layout = useLayoutContext();
    context = useFormAlertTenant();
    alerts = useFormAlerts('form', context, true);
    revoke = useRevokeFormAlert(context);
    return null;
  }
  const authenticate = async (sessionKey = 'one') => act(async () => {
    layout.setMemberInfo({ id: 'member-a', tenant_id: 'tenant-a', role_id: 'role-a' });
    layout.setSessionRoleSnapshot({
      status: 'ready', member_id: 'member-a', tenant_id: 'tenant-a', role_id: 'role-a', session_key: sessionKey,
      role: { id: 'role-a', tenant_id: 'tenant-a', excluded_features: [] },
    });
    layout.setSessionValidated(true);
    layout.setAuthResolved(true);
  });
  try {
    setActiveTenantId(null);
    setViewerProtectedWorkPaused(false);
    await act(async () => root.render(<QueryClientProvider client={client}><LayoutProvider><Probe /></LayoutProvider></QueryClientProvider>));
    assert.equal(context.status, 'loading');
    assert.throws(() => context.assertCurrent(), /session changed/);
    assert.equal(headers.length, 0);
    await authenticate();
    await settle();
    assert.equal(context.tenantId, 'tenant-a');
    assert.equal(headers.at(-1), 'tenant-a');
    const first = context;
    let pending;
    await act(async () => {
      pending = alerts.save.mutateAsync({ enabled: false, recipients: ['fixture@example.invalid'] }).catch(error => error);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(writes, 1);
    await authenticate('two');
    await act(async () => release());
    const result = await pending;
    assert.match(result.message, /session changed/);
    assert.throws(() => first.assertCurrent(), /session changed/);
    assert.notEqual(first.scopeKey, context.scopeKey);
    assert.notDeepEqual(client.getQueryData(['form-alerts', first.scopeKey, 'form'])?.recipients, ['fixture@example.invalid']);
    const beforeSwitch = context;
    await act(async () => { setActiveTenantId('tenant-b'); setActiveTenantId('tenant-a'); });
    assert.throws(() => beforeSwitch.assertCurrent(), /session changed/);
    await settle();
    const beforePause = context;
    await act(async () => invalidateViewerProtectedWork());
    assert.throws(() => beforePause.assertCurrent(), /session changed/);
    await act(async () => setViewerProtectedWorkPaused(true));
    assert.equal(context.status, 'error');
    await act(async () => {
      const failure = await revoke.mutateAsync({ formId: 'form', submissionId: 'submission' }).catch(error => error);
      assert.match(failure.message, /session changed/);
    });
    // Genuine dashboard-only session: verify the server response, not the
    // singleton. This exercises the fallback separately from portal identity.
    await act(async () => {
      layout.setMemberInfo(null);
      layout.setSessionValidated(false);
      setViewerProtectedWorkPaused(false);
    });
    await settle();
    await settle();
    assert.equal(context.status, 'ready');
    assert.equal(context.tenantId, 'tenant-a');
    await act(async () => setActiveTenantId(null));
    assert.equal(context.status, 'error');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setActiveTenantId(null);
    setViewerProtectedWorkPaused(false);
    globalThis.fetch = original;
    dom.window.close();
  }
});
