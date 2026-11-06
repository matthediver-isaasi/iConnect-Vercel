import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LayoutProvider, useLayoutContext } from '../contexts/LayoutContext.jsx';
import { base44 } from '../api/base44Client.js';
import { usePortalNavigation, readNavigationRows } from './usePortalNavigation.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = React;
const dom = new JSDOM('<html><body></body></html>', { url: 'https://example.test' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

test('navigation invalidation, retained content, tenant/account switches and late completions', async () => {
  let context, nav;
  let mounts = 0;
  const pending = [];
  let hierarchyRequest;
  let holdHierarchy = false;
  const originals = [base44.entities.PortalMenu.list, base44.entities.RoleAccessItem.list,
    base44.entities.MemberGroupAssignment.filter, globalThis.fetch];
  base44.entities.PortalMenu.list = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  base44.entities.RoleAccessItem.list = () => holdHierarchy
    ? new Promise((resolve, reject) => { hierarchyRequest = { resolve, reject }; })
    : Promise.resolve([]);
  base44.entities.MemberGroupAssignment.filter = async () => [];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [], total: 0 }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  const root = createRoot(container);
  function Content() {
    React.useEffect(() => { mounts++; }, []);
    return <input defaultValue="unsaved" />;
  }
  function Reader() {
    context = useLayoutContext();
    nav = usePortalNavigation('ready');
    return <><Content /><span>{nav.status === 'ready' ? nav.menu.map(row => row.title).join(',') : nav.status}</span></>;
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  async function authenticate(tenant, member, session) {
    await act(async () => {
      context.setMemberInfo({ id: member, tenant_id: tenant, role_id: 'r' });
      context.setSessionRoleSnapshot({ member_id: member, tenant_id: tenant, role_id: 'r', session_key: session, status: 'ready' });
      context.setSessionValidated(true);
      context.setAuthResolved(true);
      await settle();
    });
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><LayoutProvider><Reader /></LayoutProvider></QueryClientProvider>));
    await authenticate('t1', 'a', 's1');
    assert.equal(nav.status, 'loading');
    await act(async () => { pending[0].resolve([{ title: 'A' }]); await settle(); });
    assert.equal(nav.status, 'ready');
    const input = container.querySelector('input');
    await act(async () => { void client.invalidateQueries({ queryKey: ['portal-menu'] }); await settle(); });
    assert.equal(nav.status, 'loading');
    assert.equal(container.querySelector('input'), input);
    await act(async () => { pending[1].reject(new Error('Unavailable')); await settle(); });
    assert.equal(nav.status, 'error');
    await act(async () => { void nav.retry(); await settle(); });
    await authenticate('t2', 'b', 's2');
    await act(async () => { pending[2].resolve([{ title: 'Late A' }]); await settle(); });
    assert.equal(nav.status, 'loading');
    assert.equal(container.textContent.includes('Late A'), false);
    await act(async () => { pending[3].resolve([{ title: 'B' }]); await settle(); });
    assert.equal(container.textContent, 'B');
    holdHierarchy = true;
    await act(async () => { void client.invalidateQueries({ queryKey: ['role-access-items'] }); await settle(); });
    assert.equal(nav.status, 'loading');
    assert.equal(container.querySelector('input'), input);
    await act(async () => { hierarchyRequest.reject(new Error('Hierarchy failed')); await settle(); });
    assert.equal(nav.status, 'error');
    await act(async () => { void nav.retry(); await settle(); });
    await act(async () => { hierarchyRequest.resolve([{ id: 'p', item_key: 'revoked', item_type: 'module' }]); await settle(); });
    assert.equal(nav.status, 'ready');
    assert.equal(nav.hierarchy[0].item_key, 'revoked');
    holdHierarchy = false;
    await act(async () => context.setSessionValidated(false));
    assert.equal(nav.status, 'loading');
    assert.deepEqual(nav.hierarchy, []);
    await authenticate('t1', 'a', 's3');
    assert.equal(nav.status, 'loading', 'returning account cannot reuse earlier authority');
    await act(async () => { pending[4].resolve([]); await settle(); });
    assert.equal(nav.status, 'ready');
    assert.equal(mounts, 1);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    [base44.entities.PortalMenu.list, base44.entities.RoleAccessItem.list,
      base44.entities.MemberGroupAssignment.filter, globalThis.fetch] = originals;
  }
});

test('malformed and hung configuration reads fail instead of becoming empty menus', async () => {
  await assert.rejects(readNavigationRows(async () => null), /Invalid navigation/);
  await assert.rejects(readNavigationRows(() => new Promise(() => {}), 5), /timed out/);
  assert.deepEqual(await readNavigationRows(async () => []), []);
});
