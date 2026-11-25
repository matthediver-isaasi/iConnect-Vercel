import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import Module from 'node:module';
import { readFile } from 'node:fs/promises';

const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'Element', 'DocumentFragment', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};

const bundle = await build({
  entryPoints: ['client/src/components/workflows/CommunicationSubscriptionFields.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  jsx: 'automatic', alias: { '@': `${process.cwd()}/client/src` }, logLevel: 'silent',
});
const mod = new Module(`${process.cwd()}/workflow-communication-test.cjs`);
mod.filename = `${process.cwd()}/workflow-communication-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const React = mod.require('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const screen = {
  getByRole(role, { name } = {}) {
    const elements = [...document.querySelectorAll(role === 'button' ? 'button' : `[role="${role}"]`)];
    const element = elements.find(node => !name || (node.getAttribute('aria-label') || node.textContent).trim() === name);
    assert.ok(element, `Missing ${role}: ${name || ''}`);
    return element;
  },
  getAllByRole(role) { return [...document.querySelectorAll(`[role="${role}"]`)]; },
};
const click = element => act(async () => { element.click(); await tick(); });
async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); await tick(); });
  return { async unmount() { await act(async () => { root.unmount(); await tick(); }); container.remove(); } };
}
const Fields = mod.exports.default;
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const missing = '00000000-0000-4000-8000-000000000003';
const categories = [{ id: a, name: 'News' }, { id: b, name: 'Events' }];

test('real controls retain multi-selection and explicit state through save/reopen/copy', async () => {
  let saved;
  function Editor({ initial }) {
    const [config, setConfig] = React.useState(initial);
    return React.createElement(React.Fragment, null,
      React.createElement(Fields, { config, categories, onChange: setConfig }),
      React.createElement('button', { onClick: () => { saved = JSON.parse(JSON.stringify(config)); } }, 'Save fixture'));
  }
  const initial = { field_type: 'communication_categories', field_id: 'communication_categories',
    communication_subscription: { category_ids: [], is_subscribed: null } };
  try {
    const view = await render(React.createElement(Editor, { initial }));
    await click(screen.getByRole('checkbox', { name: 'News' }));
    await click(screen.getByRole('checkbox', { name: 'Events' }));
    await act(async () => {
      screen.getByRole('combobox', { name: 'Subscription state' }).dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
      await tick();
    });
    await click(screen.getByRole('option', { name: 'Unsubscribe' }));
    await click(screen.getByRole('button', { name: 'Save fixture' }));
    assert.deepEqual(saved.communication_subscription, { category_ids: [a, b], is_subscribed: false });
    await view.unmount();
    for (const persisted of [saved, JSON.parse(JSON.stringify(saved))]) {
      const reopened = await render(React.createElement(Editor, { initial: persisted }));
      assert.equal(screen.getByRole('checkbox', { name: 'News' }).getAttribute('aria-checked'), 'true');
      assert.equal(screen.getByRole('checkbox', { name: 'Events' }).getAttribute('aria-checked'), 'true');
      assert.match(screen.getByRole('combobox').textContent, /Unsubscribe/);
      await reopened.unmount();
    }
  } finally { document.body.innerHTML = ''; }
});

test('unavailable saved choices stay visible and removable; failed discovery is explicit', async () => {
  const changes = [];
  let view;
  try {
    view = await render(React.createElement(Fields, {
      config: { communication_subscription: { category_ids: [missing], is_subscribed: true } },
      categories, error: new Error('unavailable'), onChange: config => changes.push(config),
    }));
    const unavailable = screen.getByRole('checkbox', { name: `Unavailable category (${missing})` });
    assert.equal(unavailable.getAttribute('aria-checked'), 'true');
    assert.match(screen.getAllByRole('alert').map(node => node.textContent).join(' '), /could not be loaded/);
    await click(unavailable);
    assert.deepEqual(changes[0].communication_subscription.category_ids, []);
  } finally { await view?.unmount(); }
});

test('workflow page wires canonical persistence and tenant-authorized discovery', async () => {
  const source = await readFile('client/src/pages/WorkflowManagement.jsx', 'utf8');
  assert.match(source, /base44\.entities\.CommunicationCategory\.listAll\(\)/);
  assert.match(source, /normalizeWorkflowCommunicationConfig\(action.config, formData.entity_type\)/);
  assert.match(source, /actions: workflow.actions \? JSON.parse\(JSON.stringify\(workflow.actions\)\)/);
  assert.match(source, /workflowUpdateFieldSelection\(fieldType, fieldId/);
});
