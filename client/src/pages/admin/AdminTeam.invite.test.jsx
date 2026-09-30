import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/admin/team',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element',
  'DocumentFragment', 'Node', 'NodeFilter', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.PointerEvent = dom.window.MouseEvent;
globalThis.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.HTMLElement.prototype.hasPointerCapture = () => false;
globalThis.HTMLElement.prototype.setPointerCapture = () => {};
globalThis.HTMLElement.prototype.releasePointerCapture = () => {};

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { MemoryRouter } = await import('react-router-dom');
const { Toaster } = await import('sonner');
const AdminTeam = (await import('./AdminTeam.jsx')).default;
after(() => dom.window.close());

const existing = {
  id: 'team-1', identity_id: 'identity-1', email: 'owner@example.test',
  first_name: 'Team', last_name: 'Owner', role: 'owner', status: 'active', is_current_user: true,
};
const added = {
  id: 'team-2', identity_id: 'identity-2', email: 'member@example.test',
  first_name: 'Portal', last_name: 'Member', role: 'viewer', status: 'active', is_new_user: false,
};
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
const byId = id => document.querySelector(`[data-testid="${id}"]`);
const click = async element => {
  assert.ok(element, 'expected clickable element');
  await act(async () => element.click());
};
const input = async (element, value) => {
  assert.ok(element);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

async function mounted(respond, exercise) {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 },
    mutations: { retry: false, gcTime: 0 },
  } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(url, '/api/tenant/team', `unexpected network request ${url}`);
    return respond(url, options);
  };
  try {
    await act(async () => root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <AdminTeam />
          <Toaster />
        </QueryClientProvider>
      </MemoryRouter>,
    ));
    await settle();
    await exercise(calls);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
}

test('inviting an existing portal member sends the chosen role and refreshes the team list without changing others', async () => {
  let members = [existing];
  await mounted(async (_url, options) => {
    if (options.method === 'POST') {
      members = [existing, added];
      return { ok: true, json: async () => ({ success: true, member: added }) };
    }
    return { ok: true, json: async () => ({ members }) };
  }, async calls => {
    assert.ok(byId('team-member-team-1'));
    await click(byId('button-add-member'));
    await input(byId('input-email'), 'member@example.test');
    // Select the least-privileged role: a promoted portal member should get
    // exactly the access explicitly chosen by the inviter.
    const role = byId('select-role');
    await act(async () => role.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      bubbles: true, key: 'Enter',
    })));
    await settle();
    const viewer = document.querySelector('[role="option"][data-value="viewer"]')
      || [...document.querySelectorAll('[role="option"]')].find(el => el.textContent.includes('Viewer'));
    await click(viewer);
    await click(byId('button-confirm-add'));
    await settle();
    const post = calls.find(call => call.options.method === 'POST');
    assert.ok(post);
    assert.equal(post.options.credentials, 'include');
    assert.deepEqual(JSON.parse(post.options.body), {
      email: 'member@example.test', first_name: '', last_name: '', role: 'viewer',
    });
    assert.equal(calls.filter(call => !call.options.method).length, 2, 'success invalidates and refetches team list');
    assert.match(byId('team-member-team-2').textContent, /Portal Member.*member@example\.test.*Viewer/);
    assert.match(byId('team-member-team-1').textContent, /Team Owner.*owner@example\.test.*Owner/);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.body.textContent, /They can sign in with their existing account/);
  });
});

test('already-added response shows the server error, keeps the form open, and does not change any roles', async () => {
  await mounted(async (_url, options) => options.method === 'POST'
    ? { ok: false, status: 400, json: async () => ({ error: 'This user is already a team member' }) }
    : { ok: true, json: async () => ({ members: [existing, added] }) }, async calls => {
    await click(byId('button-add-member'));
    await input(byId('input-email'), 'member@example.test');
    await click(byId('button-confirm-add'));
    await settle();
    assert.match(document.body.textContent, /This user is already a team member/);
    assert.ok(document.querySelector('[role="dialog"]'), 'error must not dismiss invitation form');
    assert.equal(byId('input-email').value, 'member@example.test');
    assert.equal(calls.filter(call => !call.options.method).length, 1, 'error does not refetch or modify team');
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    assert.match(byId('team-member-team-2').textContent, /Viewer/);
    assert.match(byId('team-member-team-1').textContent, /Owner/);
  });
});