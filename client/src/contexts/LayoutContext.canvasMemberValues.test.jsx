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

test('Canvas values are session-only, atomic, fail closed, and do not revive on an identity switch back', async () => {
  let context;
  function Reader() {
    context = useLayoutContext();
    return <span>{context.canvasMemberValues['member.first_name'] || ''}</span>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const member = { id: 'a', tenant_id: 'tenant-a', organization_id: 'org-a', first_name: 'Cached impostor' };
  const snapshot = {
    memberId: 'a', tenantId: 'tenant-a', organizationId: 'org-a',
    values: { 'member.first_name': 'Authenticated Ada', 'member.organization.name': 'Verified org' },
  };
  const read = () => container.textContent;
  const authenticate = async () => act(async () => {
    context.setMemberInfo(member);
    context.setCanvasMemberSnapshot(snapshot);
    context.setSessionValidated(true);
    context.setAuthResolved(true);
  });
  try {
    await act(async () => root.render(<LayoutProvider><Reader /></LayoutProvider>));
    assert.equal(read(), '');
    await act(async () => {
      context.setMemberInfo({ ...member, canvasMemberSnapshot: snapshot });
      context.setOrganizationInfo({ id: 'org-a', name: 'Stale organisation' });
      context.setSessionValidated(true);
      context.setAuthResolved(true);
    });
    assert.equal(read(), '', 'cached member data cannot create a trusted snapshot');
    await authenticate();
    assert.equal(read(), 'Authenticated Ada');
    await act(async () => context.setOrganizationInfo({ id: 'org-b', name: 'Late unrelated response' }));
    assert.equal(context.canvasMemberValues['member.organization.name'], 'Verified org');
    await act(async () => context.setMemberInfo({ ...member, first_name: 'Untrusted change' }));
    assert.equal(read(), 'Authenticated Ada', 'uses server projection, not mutable cached fields');

    for (const changed of [
      null, { ...member, id: 'b' }, { ...member, tenant_id: 'tenant-b' },
      { ...member, organization_id: 'org-b' },
    ]) {
      await act(async () => context.setMemberInfo(changed));
      assert.equal(read(), '');
      await act(async () => context.setMemberInfo(member));
      assert.equal(read(), '', 'returning to an old identity cannot revive its snapshot');
      await authenticate();
    }
    await act(async () => context.setSessionValidated(false));
    assert.equal(read(), '');
    await act(async () => context.setSessionValidated(true));
    assert.equal(read(), '', 'validation flag alone cannot revive a cleared snapshot');
    await authenticate();
    await act(async () => context.setAuthResolved(false));
    assert.equal(read(), '');
    await act(async () => context.setAuthResolved(true));
    assert.equal(read(), '', 'loading clears the old viewer permanently');
  } finally {
    await act(async () => root.unmount());
  }
});