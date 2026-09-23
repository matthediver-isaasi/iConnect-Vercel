import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.example.test/admin/members/member-a',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.PointerEvent = dom.window.PointerEvent || dom.window.MouseEvent;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { setActiveTenantId } = await import('@/api/base44Client');
const {
  default: MemberEmails,
  loadAuthenticatedTenant,
  memberEmailProviderLabel,
} = await import('./MemberEmails.jsx');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

async function settle(turns = 4) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

function change(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
    'value',
  ).set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemberEmails
          memberId="member-a"
          memberEmail="member.a@example.com"
          memberName="Member A"
        />
      </QueryClientProvider>,
    );
  });
  await settle();
  return {
    queryClient,
    async cleanup() {
      await act(async () => root.unmount());
      queryClient.clear();
      document.body.innerHTML = '';
    },
  };
}

test('direct entry survives fetch-interceptor null-to-tenant bootstrap and composes without Outlook', async () => {
  setActiveTenantId(null);
  const requests = [];
  let bootstrapped = false;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/auth/tenant-user-me') {
      // The production global fetch interceptor performs this synchronous
      // store update after reading the same successful auth response.
      if (!bootstrapped) {
        bootstrapped = true;
        setActiveTenantId('tenant-a');
      }
      return response({ authenticated: true, tenant: { id: 'tenant-a' } });
    }
    if (url === '/api/outlook/sync') return response({ synced: 0 });
    if (url === '/api/outlook/emails/member-a') return response({ error: 'Outlook unavailable' }, 503);
    if (url === '/api/crm/send') return response({ success: true, warning: 'History logging was delayed.' });
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mount();
  try {
    assert.match(document.body.textContent, /Unable to load emails/);
    await act(async () => {
      document.querySelector('[data-testid="button-compose-email"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    assert.equal(document.querySelector('[data-testid="input-email-to"]').value, 'member.a@example.com');
    assert.match(document.body.textContent, /verified sender domain/);

    await act(async () => {
      change(document.querySelector('[data-testid="input-email-subject"]'), 'Subject');
      change(document.querySelector('[data-testid="input-email-body"]'), 'Message');
      document.querySelector('[data-testid="button-send-email"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    const send = requests.find(request => request.url === '/api/crm/send');
    assert.ok(send);
    const authRequests = requests.filter(request => request.url === '/api/auth/tenant-user-me');
    assert.ok(authRequests.length >= 2);
    assert.equal(authRequests.at(-1).options.headers['X-Tenant-Id'], 'tenant-a');
    assert.equal(requests.some(request => request.url === '/api/outlook/send'), false);
    assert.deepEqual(JSON.parse(send.options.body), {
      tenantId: 'tenant-a',
      memberId: 'member-a',
      to: 'member.a@example.com',
      cc: '',
      subject: 'Subject',
      body: 'Message',
      bodyType: 'text',
    });
  } finally {
    await view.cleanup();
    setActiveTenantId(null);
  }
});

test('authenticated tenant mismatch blocks history and composer', async () => {
  setActiveTenantId('tenant-a');
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url === '/api/auth/tenant-user-me') {
      return response({ authenticated: true, tenant: { id: 'tenant-b' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mount();
  try {
    assert.match(document.body.textContent, /Organisation context changed/);
    assert.equal(document.querySelector('[data-testid="button-compose-email"]'), null);
    assert.equal(requests.some(url => url.startsWith('/api/outlook/')), false);
  } finally {
    await view.cleanup();
    setActiveTenantId(null);
  }
});

test('member-admin authentication is used only after a successful unauthenticated tenant-user response', async () => {
  setActiveTenantId('tenant-a');
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/auth/tenant-user-me') return response({ authenticated: false });
    if (url === '/api/auth/me') return response({ id: 'member-admin-a', tenant_id: 'tenant-a' });
    if (url === '/api/outlook/sync') return response({ synced: 0 });
    if (url === '/api/outlook/emails/member-a') return response({ error: 'Outlook unavailable' }, 503);
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mount();
  try {
    assert.match(document.body.textContent, /Unable to load emails/);
    assert.ok(requests.some(request => request.url === '/api/auth/me'));
    assert.equal(
      requests.find(request => request.url === '/api/auth/me').options.headers['X-Tenant-Id'],
      'tenant-a',
    );
    assert.ok(document.querySelector('[data-testid="button-compose-email"]'));
  } finally {
    await view.cleanup();
    setActiveTenantId(null);
  }
});

test('tenant-user HTTP failure never falls back to member authentication', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return response({ error: 'Tenant session lookup failed' }, 503);
  };
  await assert.rejects(
    loadAuthenticatedTenant(null),
    /Tenant session lookup failed/,
  );
  assert.deepEqual(urls, ['/api/auth/tenant-user-me']);
});

test('failed tenant refetch blocks a previously ready composer', async () => {
  setActiveTenantId('tenant-a');
  let authFails = false;
  globalThis.fetch = async (url) => {
    if (url === '/api/auth/tenant-user-me') {
      return authFails
        ? response({ error: 'Session refresh failed' }, 503)
        : response({ authenticated: true, tenant: { id: 'tenant-a' } });
    }
    if (url === '/api/outlook/sync') return response({ synced: 0 });
    if (url === '/api/outlook/emails/member-a') return response({ emails: [] });
    throw new Error(`Unexpected request: ${url}`);
  };

  const view = await mount();
  try {
    assert.ok(document.querySelector('[data-testid="button-compose-email"]'));
    authFails = true;
    await act(async () => {
      await view.queryClient.refetchQueries({
        queryKey: ['authenticated-email-tenant', 'tenant-a'],
        exact: true,
      });
    });
    await settle();
    assert.match(document.body.textContent, /Session refresh failed/);
    assert.equal(document.querySelector('[data-testid="button-compose-email"]'), null);
  } finally {
    await view.cleanup();
    setActiveTenantId(null);
  }
});

test('history provider labels only use persisted provider metadata', () => {
  assert.equal(memberEmailProviderLabel({ email_provider: 'mailgun' }), 'Mailgun');
  assert.equal(memberEmailProviderLabel({ email_provider: 'microsoft_graph' }), 'Outlook');
  assert.equal(memberEmailProviderLabel({ provider: 'mailgun' }), null);
  assert.equal(memberEmailProviderLabel({}), null);
});