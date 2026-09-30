import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { LayoutProvider, useLayoutContext } from './LayoutContext.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = React;
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

test('trusted session role is discarded on role, tenant, account, and auth changes', async () => {
  let context;
  function Reader() {
    context = useLayoutContext();
    return <span>{context.sessionRoleSnapshot?.role?.name || ''}</span>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const member = { id: 'member-a', tenant_id: 'tenant-a', role_id: 'role-a' };
  const snapshot = {
    status: 'ready',
    member_id: 'member-a',
    tenant_id: 'tenant-a',
    role_id: 'role-a',
    session_key: 'session-a',
    role: { id: 'role-a', name: 'Member' },
  };

  const authenticate = () => act(async () => {
    context.setMemberInfo(member);
    context.setSessionRoleSnapshot(snapshot);
    context.setSessionValidated(true);
    context.setAuthResolved(true);
  });

  try {
    await act(async () => root.render(<LayoutProvider><Reader /></LayoutProvider>));
    await authenticate();
    assert.equal(container.textContent, 'Member');
    await act(async () => {
      context.setMemberRole(snapshot.role);
      // Layout's local member commit can follow the direct auth-context commit
      // on a later render when /auth/me was delayed.
      context.setMemberInfo({ ...member, sessionExpiry: 'later' });
    });
    assert.equal(context.memberRole?.name, 'Member');
    assert.equal(container.textContent, 'Member');

    for (const changedMember of [
      { ...member, role_id: 'role-b' },
      { ...member, tenant_id: 'tenant-b' },
      { ...member, id: 'member-b' },
      null,
    ]) {
      await act(async () => context.setMemberInfo(changedMember));
      assert.equal(container.textContent, '');
      await authenticate();
    }

    await act(async () => context.setSessionValidated(false));
    assert.equal(container.textContent, '');
    await authenticate();
    await act(async () => context.setAuthResolved(false));
    assert.equal(container.textContent, '');
  } finally {
    await act(async () => root.unmount());
  }
});