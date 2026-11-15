import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<html><body></body></html>', { url: 'https://example.test' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = (await import('react')).default;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const source = await fs.readFile('client/src/pages/ProjectBoard.jsx', 'utf8');
const imports = source.slice(0, source.indexOf('const PRIORITY_COLORS')).split('\n');
// Bundle the actual settings component, without unrelated board-page dependencies.
const contents = imports.filter(line => /^import React|^import \{ useQuery|^import .*@\/components\/ui\/|^import \{ toast|^import \{ apiRequest/.test(line)).join('\n') +
  '\nimport { Settings, Loader2, Plus, Trash2 } from "lucide-react";\n' +
  source.slice(source.indexOf('export function BoardSettingsModal'));
const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', logLevel: 'silent' });
const compiled = new Module(`${process.cwd()}/invite-test.cjs`);
compiled.filename = `${process.cwd()}/invite-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { BoardSettingsModal } = compiled.exports;
const { QueryClient, QueryClientProvider } = compiled.require('@tanstack/react-query');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });
const pause = () => new Promise(r => setTimeout(r, 40));
async function settle() { await act(pause); await act(pause); }
async function click(el) { assert.ok(el); await act(async () => el.click()); }
async function select(id, label) {
  await act(async () => document.getElementById(id).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  await click([...document.querySelectorAll('[role="option"]')].find(el => el.textContent === label));
  await settle();
}

test('mounted invite filter supports role-only, combined, clearing, independent permission and invalidation', async () => {
  const calls = []; let added = false; let fail = false; let hold;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/membership/roles')) return { ok: true, json: async () => ({ data: [{ id: 'role-a', name: 'Professional' }] }) };
    if (options.method === 'POST') { added = true; return { ok: true, status: 201, json: async () => ({ member: {} }) }; }
    if (hold) await hold;
    return { ok: !fail, json: async () => ({ users: added ? [] : [{ id: 'person', first_name: 'Test', email: 'test@example.test' }] }) };
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); let changes = 0;
  try {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(BoardSettingsModal, { boardId: 'board', boardName: 'Board', open: true, members: [], userRole: 'owner', onMembersChange: () => changes++, onOpenChange() {} }))));
    await settle();
    assert.match(document.getElementById('invite-member-role').textContent, /All roles/);
    await select('invite-board-permission', 'Viewer');
    await select('invite-member-role', 'Professional');
    assert.ok(calls.at(-1).url.includes('role_id=role-a'));
    await act(async () => {
      const input = document.getElementById('invite-search');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'test@');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await settle();
    assert.match(calls.at(-1).url, /search=test%40&role_id=role-a/);
    await select('invite-member-role', 'All roles');
    assert.ok(!calls.at(-1).url.includes('role_id'));
    await select('invite-member-role', 'Professional');
    assert.match(document.getElementById('invite-board-permission').textContent, /Viewer/);
    await click(document.querySelector('[data-testid="button-add-member-person"]'));
    await settle();
    assert.deepEqual(JSON.parse(calls.find(c => c.options.method === 'POST').options.body), { identity_id: 'person', role: 'viewer' });
    assert.equal(changes, 1);
    assert.equal(document.querySelector('[data-testid="button-add-member-person"]'), null);
    assert.match(document.body.textContent, /No matching people/);
    assert.ok(client.getQueryCache().findAll({ queryKey: ['available-users', 'board'] }).filter(q => q.queryKey[3] === 'all').every(q => q.state.isInvalidated));
    fail = true;
    await act(async () => { await client.invalidateQueries({ queryKey: ['available-users'] }); });
    await settle();
    assert.match(document.body.textContent, /Could not load people/);
    fail = false;
    let release; hold = new Promise(r => { release = r; });
    await click([...document.querySelectorAll('button')].find(el => el.textContent === 'Try again'));
    await settle();
    assert.match(document.body.textContent, /Loading people/);
    release(); hold = null; await settle();
    assert.match(document.body.textContent, /No matching people/);
  } finally {
    await act(async () => root.unmount()); client.clear(); container.remove();
  }
});
