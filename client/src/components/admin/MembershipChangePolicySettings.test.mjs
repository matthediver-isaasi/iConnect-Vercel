import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const bundle = await build({
  entryPoints: ['client/src/components/admin/MembershipChangePolicySettings.jsx'],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  plugins: [{
    name: 'identity-boundary-only',
    setup(builder) {
      builder.onResolve({ filter: /^@\/api\/base44Client$/ }, () => ({ path: 'tenant', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@\/lib\/queryClient$/ }, () => ({ path: 'events', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
        contents: args.path === 'tenant'
          ? 'export const getActiveTenantId = () => "wrong-global-tenant";'
          : 'export const emitTenantContextChanged = () => { globalThis.__policyTenantChanged = true; };',
        loader: 'js',
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/membership-policy-test.cjs`);
compiled.filename = `${process.cwd()}/membership-policy-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Settings = compiled.exports.default;
const React = compiled.require('react');
const { act } = React;
const { createRoot } = compiled.require('react-dom/client');
const { QueryClient, QueryClientProvider } = compiled.require('@tanstack/react-query');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });

const defaultPolicy = {
  surplusHandling: 'approval', creditExpiryDays: null, upgradesRequireApproval: true,
  downgradesRequireApproval: true, cancellationTiming: 'end_of_term', cancellationUnusedValue: 'none',
};
const payload = (policy = {}, revision = 0) => ({
  policy: { ...defaultPolicy, ...policy }, revision, executionEnabled: false,
});
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
function button(container, text) {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent === text);
  assert.ok(result, `Missing button: ${text}`);
  return result;
}
async function click(element) {
  await act(async () => { element.click(); });
  await settle();
}
async function select(container, id, value) {
  const element = container.querySelector(`#${id}`);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}
async function expiry(container, value) {
  const input = container.querySelector('#membership-credit-expiry');
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function mount(handler, run, tenantId = 'tenant-a') {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/admin/membership-change-policy');
    calls.push({ url, options });
    return handler(options, calls.length);
  };
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 },
  } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async id => {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(Settings, { tenantId: id }))));
    await settle();
  };
  try {
    await render(tenantId);
    await run({ container, calls, render, client });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  }
}

test('loads verified tenant policy, conservative defaults and configuration-only notice', async () => {
  await mount(() => response(payload()), async ({ container, calls }) => {
    assert.equal(calls[0].options.headers.get('X-Tenant-Id'), 'tenant-a');
    assert.equal(calls[0].options.credentials, 'include');
    assert.match(container.textContent, /does not enable self-service membership changes, process money, or alter existing forms/);
    assert.equal(container.querySelector('#membership-surplus').value, 'approval');
    assert.equal(container.querySelector('#membership-credit-expiry').value, '');
    assert.equal(container.querySelector('#membership-upgrade-approval').getAttribute('aria-checked'), 'true');
    assert.equal(container.querySelectorAll('[role="switch"]').length, 2, 'No master execution switch');
    assert.equal(button(container, 'Save membership policy').disabled, true);
  });
});

test('saves complete typed policy with expected revision; patches cache and resets dirty state', async () => {
  await mount(options => response(options.method === 'PUT'
    ? payload(JSON.parse(options.body).policy, 8) : payload({}, 7)), async ({ container, calls, client }) => {
    await select(container, 'membership-surplus', 'credit');
    await expiry(container, '36500');
    await click(container.querySelector('#membership-upgrade-approval'));
    await select(container, 'membership-cancellation-timing', 'immediate');
    await select(container, 'membership-cancellation-unused', 'tenant_surplus_policy');
    await click(button(container, 'Save membership policy'));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, 'PUT');
    assert.equal(calls[1].options.headers.get('X-Tenant-Id'), 'tenant-a');
    const sent = JSON.parse(calls[1].options.body);
    assert.deepEqual(sent, { policy: {
      surplusHandling: 'credit', creditExpiryDays: 36500, upgradesRequireApproval: false,
      downgradesRequireApproval: true, cancellationTiming: 'immediate', cancellationUnusedValue: 'tenant_surplus_policy',
    }, expectedRevision: 7 });
    assert.equal(client.getQueryData(['admin-membership-change-policy', 'tenant-a']).revision, 8);
    assert.match(container.textContent, /Configuration saved. Member execution remains disabled/);
    assert.equal(button(container, 'Save membership policy').disabled, true);
  });
});

test('validates expiry boundaries and integer values, supports null and discarding edits', async () => {
  await mount(options => response(options.method === 'PUT'
    ? payload(JSON.parse(options.body).policy, 2) : payload({ creditExpiryDays: 18 }, 1)), async ({ container, calls }) => {
    for (const invalid of ['0', '-1', '1.5', '36501']) {
      await expiry(container, invalid);
      assert.equal(container.querySelector('#membership-credit-expiry').getAttribute('aria-invalid'), 'true');
      assert.equal(button(container, 'Save membership policy').disabled, true);
    }
    await click(button(container, 'Discard changes'));
    assert.equal(container.querySelector('#membership-credit-expiry').value, '18');
    await expiry(container, '1');
    assert.equal(button(container, 'Save membership policy').disabled, false);
    await expiry(container, '');
    await click(button(container, 'Save membership policy'));
    assert.equal(JSON.parse(calls[1].options.body).policy.creditExpiryDays, null);
  });
});

test('missing migration is a visible retryable error, never an editable fallback', async () => {
  await mount((_options, count) => count === 1
    ? response({ error: 'Migration not deployed' }, 503) : response(payload()), async ({ container, calls }) => {
    assert.match(container.querySelector('[role="alert"]').textContent, /migration may not be deployed/);
    assert.equal(container.querySelector('#membership-surplus'), null);
    await click(button(container, 'Retry loading policy'));
    assert.equal(calls.length, 2);
    assert.ok(container.querySelector('#membership-surplus'));
  });
});

test('save errors preserve edits and never claim success; retry saves the same revision', async () => {
  let puts = 0;
  await mount(options => options.method !== 'PUT' ? response(payload({}, 3))
    : ++puts === 1 ? response({ error: 'Database migration missing' }, 500)
      : response(payload(JSON.parse(options.body).policy, 4)), async ({ container, calls }) => {
    await select(container, 'membership-surplus', 'refund');
    await click(button(container, 'Save membership policy'));
    assert.match(container.querySelector('[role="alert"]').textContent, /Database migration missing/);
    assert.doesNotMatch(container.textContent, /Configuration saved/);
    assert.equal(container.querySelector('#membership-surplus').value, 'refund');
    await click(button(container, 'Save membership policy'));
    assert.equal(JSON.parse(calls[2].options.body).expectedRevision, 3);
    assert.match(container.textContent, /Configuration saved/);
  });
});

test('409 retains draft and blocks overwrite until explicit discard and reload', async () => {
  await mount((options, count) => options.method === 'PUT'
    ? response({ error: 'Conflict' }, 409)
    : response(count === 1 ? payload({}, 2) : payload({ surplusHandling: 'credit' }, 3)), async ({ container, calls }) => {
    await select(container, 'membership-surplus', 'refund');
    await click(button(container, 'Save membership policy'));
    assert.match(container.textContent, /another administrator/);
    assert.equal(container.querySelector('#membership-surplus').value, 'refund');
    assert.equal(button(container, 'Save membership policy').disabled, true);
    await click(button(container, 'Discard edits and reload latest policy'));
    assert.equal(calls.length, 3);
    assert.equal(container.querySelector('#membership-surplus').value, 'credit');
    assert.match(container.textContent, /revision 3/);
  });
});

test('tenant switching clears drafts and isolates late save responses and cache keys', async () => {
  let finishSave;
  await mount(options => options.method === 'PUT' ? new Promise(resolve => { finishSave = resolve; })
    : response(payload({ surplusHandling: options.headers.get('X-Tenant-Id') === 'tenant-b' ? 'credit' : 'approval' }, 4)),
  async ({ container, calls, render, client }) => {
    await select(container, 'membership-surplus', 'refund');
    await click(button(container, 'Save membership policy'));
    await render('tenant-b');
    assert.equal(container.querySelector('#membership-surplus').value, 'credit');
    assert.equal(calls[2].options.headers.get('X-Tenant-Id'), 'tenant-b');
    await act(async () => finishSave(response(payload({ surplusHandling: 'refund' }, 5))));
    await settle();
    assert.equal(container.querySelector('#membership-surplus').value, 'credit');
    assert.doesNotMatch(container.textContent, /Configuration saved/);
    assert.equal(client.getQueryData(['admin-membership-change-policy', 'tenant-b']).policy.surplusHandling, 'credit');
  });
});

test('invalid responses fail visibly instead of inventing a successful load', async () => {
  await mount(() => response({ ...payload(), executionEnabled: true }), async ({ container }) => {
    assert.match(container.querySelector('[role="alert"]').textContent, /invalid membership change policy/);
    assert.equal(container.querySelector('#membership-surplus'), null);
  });
});

test('unconfirmed save response is visible and leaves the draft dirty', async () => {
  await mount(options => response(options.method === 'PUT' ? { success: true } : payload()), async ({ container }) => {
    await select(container, 'membership-surplus', 'credit');
    await click(button(container, 'Save membership policy'));
    assert.match(container.querySelector('[role="alert"]').textContent, /successful save could not be confirmed/);
    assert.doesNotMatch(container.textContent, /Configuration saved/);
    assert.equal(button(container, 'Save membership policy').disabled, false);
  });
});

test('adminFetch still signals stale tenant context and blocks saving', async () => {
  globalThis.__policyTenantChanged = false;
  try {
    await mount(options => options.method === 'PUT'
      ? response({ code: 'TENANT_CONTEXT_CHANGED' }, 409) : response(payload()), async ({ container }) => {
      await select(container, 'membership-surplus', 'refund');
      await click(button(container, 'Save membership policy'));
      assert.equal(globalThis.__policyTenantChanged, true);
      assert.match(container.querySelector('[role="alert"]').textContent, /tenant context has changed/);
      assert.equal(button(container, 'Save membership policy').disabled, true);
    });
  } finally {
    delete globalThis.__policyTenantChanged;
  }
});

test('background cache updates do not erase in-progress edits or silently advance their revision', async () => {
  await mount(options => response(options.method === 'PUT'
    ? payload(JSON.parse(options.body).policy, 6) : payload({}, 4)), async ({ container, calls, client }) => {
    await select(container, 'membership-surplus', 'refund');
    await act(async () => client.setQueryData(['admin-membership-change-policy', 'tenant-a'], payload({ surplusHandling: 'credit' }, 5)));
    assert.equal(container.querySelector('#membership-surplus').value, 'refund');
    await click(button(container, 'Save membership policy'));
    assert.equal(JSON.parse(calls[1].options.body).expectedRevision, 4);
  });
});

test('no tenant means no request and no editable policy', async () => {
  await mount(() => { throw new Error('No tenant request allowed'); }, async ({ container, calls }) => {
    assert.equal(calls.length, 0);
    assert.match(container.textContent, /Select a verified tenant/);
    assert.equal(container.querySelector('#membership-surplus'), null);
  }, null);
});
