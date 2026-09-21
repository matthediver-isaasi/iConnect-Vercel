import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://tenant.test' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'HTMLInputElement', 'MutationObserver', 'CustomEvent', 'Event', 'localStorage']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
globalThis.React = React;
const { act, useEffect } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { LayoutProvider, useLayoutContext } = await import('../contexts/LayoutContext.jsx');
const { TooltipProvider } = await import('../components/ui/tooltip');
const { base44 } = await import('../api/base44Client.js');
const { publishRoleSettingsCopy, refreshRoleSettingsQueries, ROLE_SETTINGS_CHANGED } = await import('../lib/roleSettingsCopy.js');
const OrganisationPreferences = (await import('./OrganisationPreferences.jsx')).default;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail('Timed out waiting for organisation permissions');
}

function AuthenticatedPage() {
  const { setAuthResolved } = useLayoutContext();
  useEffect(() => { setAuthResolved(true); }, [setAuthResolved]);
  return <OrganisationPreferences />;
}

for (const mode of ['same-tab', 'other-tab']) {
  test(`${mode} copy discards organisation drafts, stays locked after failed reload, and unlocks only after retry`, async () => {
    const originals = new Map();
    for (const entity of ['Role', 'PreferenceField', 'SystemSettings']) {
      originals.set(entity, base44.entities[entity].list);
      base44.entities[entity].list = async () => entity === 'Role' ? [{ id: 'target', name: 'Target' }] : [];
    }
    const originalFetch = globalThis.fetch;
    let failReload = false;
    let deferNextRead = false;
    let resolveStaleRead;
    let putCount = 0;
    let saved;
    const authoritative = { target: { name: 'read' } };
    globalThis.fetch = async (_url, options = {}) => {
      if (options.method === 'PUT') {
        putCount += 1;
        saved = JSON.parse(options.body);
      }
      if (options.method !== 'PUT' && deferNextRead) {
        deferNextRead = false;
        return new Promise(resolve => { resolveStaleRead = resolve; });
      }
      return { ok: !failReload, json: async () => structuredClone(authoritative) };
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const cell = () => container.querySelector('[data-testid="perm-cell"]');
    const save = () => container.querySelector('[data-testid="button-save-permissions"]');
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><LayoutProvider>
        <TooltipProvider><AuthenticatedPage /></TooltipProvider>
      </LayoutProvider></QueryClientProvider>));
      await waitFor(cell);
      assert.match(cell().className, /bg-blue-100/);
      await act(async () => cell().click());
      assert.ok(save(), 'a draft exists before the copy');
      deferNextRead = true;
      await act(async () => { void client.refetchQueries({ queryKey: ['bulk-org-field-permissions'] }); });
      await waitFor(() => resolveStaleRead);
      failReload = true;
      await act(async () => {
        if (mode === 'same-tab') publishRoleSettingsCopy('target');
        else window.dispatchEvent(new dom.window.StorageEvent('storage', {
          key: ROLE_SETTINGS_CHANGED,
          newValue: JSON.stringify({ targetRoleId: 'target', revision: 'remote-copy' }),
        }));
      });
      assert.equal(save(), null, 'stale save disappears synchronously');
      assert.equal(cell(), null, 'stale matrix cannot be edited');
      await act(async () => refreshRoleSettingsQueries(client));
      await waitFor(() => container.querySelector('[role="alert"]'));
      assert.match(container.querySelector('[role="alert"]').textContent, /Unable to reload organisation field permissions/);
      assert.equal(save(), null);
      assert.equal(cell(), null);
      assert.equal(putCount, 0);
      await act(async () => resolveStaleRead({
        ok: true, json: async () => ({ target: { name: 'read_write' } }),
      }));
      await settle();
      assert.equal(cell(), null, 'a pre-copy request completing late cannot unlock stale permissions');
      assert.equal(save(), null);

      // Intentionally return identical data: structural sharing must not keep
      // the stale lock engaged or restore the discarded local draft.
      failReload = false;
      await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry').click());
      await waitFor(cell);
      assert.match(cell().className, /bg-blue-100/);
      assert.equal(save(), null, 'discarded draft is not resurrected');
      await act(async () => cell().click());
      await act(async () => save().click());
      await waitFor(() => putCount === 1);
      assert.deepEqual(saved, { permissions: { target: { name: 'hidden' } } });
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      globalThis.fetch = originalFetch;
      for (const [entity, original] of originals) base44.entities[entity].list = original;
    }
  });
}

test.after(() => dom.window.close());