import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LayoutProvider, useLayoutContext } from '../contexts/LayoutContext.jsx';
import { base44 } from '../api/base44Client.js';
import { useMemberAccess } from './useMemberAccess.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = React;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

test('verified role bypasses Role GET, invalidation refreshes it, and missing fails closed', async () => {
  let context;
  let access;
  function Reader() {
    context = useLayoutContext();
    access = useMemberAccess();
    return <span>{access.memberRole?.name || access.roleStatus}</span>;
  }

  const roleProxy = base44.entities.Role;
  const originalGet = roleProxy.get;
  let gets = 0;
  roleProxy.get = async () => {
    gets += 1;
    return { id: 'r1', tenant_id: 't1', name: 'Refreshed', excluded_features: ['admin.role-management'] };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  const root = createRoot(container);
  const member = { id: 'm1', tenant_id: 't1', role_id: 'r1' };

  try {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <LayoutProvider><Reader /></LayoutProvider>
      </QueryClientProvider>,
    ));
    await act(async () => {
      context.setMemberInfo(member);
      context.setSessionRoleSnapshot({
        status: 'ready',
        member_id: 'm1',
        tenant_id: 't1',
        role_id: 'r1',
        session_key: 'fresh-session',
        role: { id: 'r1', tenant_id: 't1', name: 'Verified', excluded_features: [] },
      });
      context.setSessionValidated(true);
      context.setAuthResolved(true);
    });
    assert.equal(gets, 0, 'fresh verified snapshot must not issue Role GET');
    assert.equal(access.memberRole.name, 'Verified');
    assert.equal(access.isFeatureExcluded('admin.role-management'), false);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['memberRole'] });
      // React Query batches observer notifications after the refetch promise.
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.equal(gets, 1);
    assert.equal(access.memberRole.name, 'Refreshed');
    assert.equal(access.isFeatureExcluded('admin.role-management'), true);

    await act(async () => context.setSessionRoleSnapshot({
      status: 'missing',
      member_id: 'm1',
      tenant_id: 't1',
      role_id: 'r1',
      session_key: 'fresh-session',
    }));
    assert.equal(access.isAccessReady, true, 'terminal failures do not leave access spinners running');
    assert.equal(access.isFeatureExcluded('admin.role-management'), true);
  } finally {
    roleProxy.get = originalGet;
    await act(async () => root.unmount());
    queryClient.clear();
  }
});

test('a second legacy observer does not restart role loading within the validated session', async () => {
  let context;
  const observed = [];
  function Reader({ captureContext = false }) {
    if (captureContext) context = useLayoutContext();
    const access = useMemberAccess();
    observed.push(access.roleStatus);
    return <span>{access.roleStatus}</span>;
  }

  const roleProxy = base44.entities.Role;
  const originalGet = roleProxy.get;
  let gets = 0;
  roleProxy.get = async () => {
    gets += 1;
    return { id: 'r1', tenant_id: 't1', name: 'Legacy role', excluded_features: [] };
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = second => (
    <QueryClientProvider client={queryClient}>
      <LayoutProvider>
        <Reader captureContext />
        {second ? <Reader /> : null}
      </LayoutProvider>
    </QueryClientProvider>
  );

  try {
    await act(async () => root.render(render(false)));
    await act(async () => {
      context.setMemberInfo({ id: 'm1', tenant_id: 't1', role_id: 'r1' });
      context.setSessionRoleSnapshot({
        status: 'legacy',
        member_id: 'm1',
        tenant_id: 't1',
        role_id: 'r1',
        session_key: 'legacy-session',
      });
      context.setSessionValidated(true);
      context.setAuthResolved(true);
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.equal(gets, 1);
    assert.match(container.textContent, /ready/);

    observed.length = 0;
    await act(async () => {
      root.render(render(true));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.equal(gets, 1, 'mounting another observer must reuse the session-scoped legacy result');
    assert.equal(observed.includes('loading'), false, 'the settled role must not flash back to loading');
    assert.equal(container.textContent, 'readyready');
  } finally {
    roleProxy.get = originalGet;
    await act(async () => root.unmount());
    queryClient.clear();
  }
});