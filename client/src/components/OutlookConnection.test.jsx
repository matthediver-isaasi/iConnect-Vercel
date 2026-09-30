import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://tenant.test/settings'
});

for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'SVGElement', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent'
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'window' ? dom.window : dom.window[key]
  });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const OutlookConnection = (await import('./OutlookConnection.jsx')).default;

const settle = () => act(async () => {
  await new Promise(resolve => setTimeout(resolve, 20));
});

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

async function mount(url, statusFetch) {
  window.history.replaceState({}, '', url);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (requestUrl, options) => {
    requests.push({ url: requestUrl, options });
    if (requestUrl === '/api/outlook/status') return statusFetch();
    if (requestUrl === '/api/admin/outlook-sync-settings') {
      return jsonResponse({ frequency_minutes: 15 });
    }
    throw new Error(`Unexpected request: ${requestUrl}`);
  };

  await act(async () => root.render(<OutlookConnection />));
  await settle();

  return {
    container,
    requests,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    }
  };
}

test('first connection reloads status, keeps unrelated URL state, and renders connected account', async () => {
  const view = await mount(
    '/settings?section=integrations&outlook_connected=true#outlook',
    () => jsonResponse({
      connected: true,
      status: 'active',
      displayName: 'Alex Example',
      email: 'alex@example.test'
    })
  );
  try {
    assert.equal(window.location.pathname, '/settings');
    assert.equal(window.location.search, '?section=integrations');
    assert.equal(window.location.hash, '#outlook');
    assert.match(view.container.textContent, /Alex Example/);
    assert.match(view.container.textContent, /Active/);
    assert.equal(
      view.requests.filter(request => request.url === '/api/outlook/status').length,
      1
    );
  } finally {
    await view.unmount();
  }
});

test('reconnect-required status provides an isolated Microsoft authorization link', async () => {
  const view = await mount('/settings', () => jsonResponse({
    connected: true,
    status: 'active',
    healthState: 'reconnect_required',
    email: 'alex@example.test'
  }));
  try {
    const reconnect = view.container.querySelector('[data-testid="button-reconnect-outlook"]');
    assert.ok(reconnect);
    const href = new URL(reconnect.href);
    assert.equal(href.pathname, '/api/auth/outlook');
    assert.equal(href.searchParams.get('returnTo'), '/settings');
    assert.equal(href.searchParams.get('originHost'), 'tenant.test');
    assert.equal(href.searchParams.has('teamsOrganizer'), false);
  } finally {
    await view.unmount();
  }
});

test('callback failure remains accessible with retry even when an existing connection loads', async () => {
  const cases = [
    ['oauth_denied', /cancelled or denied.*retry when you are ready/i],
    ['save_failed', /could not be saved/i],
    ['invalid_state', /invalid or expired/i],
    ['missing_params', /incomplete authorization response/i],
    ['user_info_failed', /account details/i],
    ['callback_failed', /could not finish/i],
    ['config_error', /not configured/i],
    ['provider_error', /Microsoft could not complete the request/i],
    ['unexpected_provider_code', /could not be completed/i]
  ];

  for (const [code, expected] of cases) {
    const view = await mount(
      `/settings?tab=email&outlook_error=${code}#connection`,
      () => jsonResponse({
        connected: true,
        status: 'active',
        displayName: 'Existing account',
        email: 'existing@example.test'
      })
    );
    try {
      const alert = view.container.querySelector('[role="alert"]');
      const retry = view.container.querySelector('[data-testid="button-retry-outlook"]');
      assert.ok(alert, `${code} renders a persistent alert`);
      assert.match(alert.textContent, expected);
      assert.ok(retry, `${code} renders retry`);
      assert.match(view.container.textContent, /Existing account/);
      assert.equal(window.location.search, '?tab=email');
      assert.equal(window.location.hash, '#connection');
    } finally {
      await view.unmount();
    }
  }
});

test('status request failures are explicit and retry reloads the status in place', async () => {
  let attempts = 0;
  const view = await mount('/settings', () => {
    attempts += 1;
    if (attempts === 1) return jsonResponse({}, { ok: false, status: 503 });
    return jsonResponse({
      connected: true,
      status: 'active',
      displayName: 'Recovered account',
      email: 'recovered@example.test'
    });
  });
  try {
    const alert = view.container.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent, /could not load the Outlook connection status/i);

    await act(async () => {
      view.container.querySelector('[data-testid="button-retry-outlook-status"]').click();
    });
    await settle();

    assert.equal(attempts, 2);
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.match(view.container.textContent, /Recovered account/);
  } finally {
    await view.unmount();
  }
});