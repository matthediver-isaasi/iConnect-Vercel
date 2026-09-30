import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/builder',
  pretendToBeVisual: true,
});
const { window } = dom;
for (const name of [
  'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'Element', 'DocumentFragment', 'Node', 'NodeFilter', 'Event', 'CustomEvent',
  'MutationObserver', 'getComputedStyle', 'localStorage', 'sessionStorage',
  'location', 'history',
]) {
  Object.defineProperty(globalThis, name, {
    value: window[name], configurable: true, writable: true,
  });
}
globalThis.window = window;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Module._extensions['.css'] = () => {};

const bundle = await build({
  entryPoints: ['client/src/pages/FormBuilder.jsx'],
  bundle: true,
  write: false,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const bundledModule = new Module(`${process.cwd()}/form-builder-role-test-memory.cjs`);
bundledModule.filename = `${process.cwd()}/form-builder-role-test-memory.cjs`;
bundledModule.paths = Module._nodeModulePaths(process.cwd());
bundledModule._compile(bundle.outputFiles[0].text, bundledModule.filename);
const { MemberRoleAssignmentEditor } = bundledModule.exports;
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

after(() => dom.window.close());

async function renderEditor(member, fields = []) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(MemberRoleAssignmentEditor, {
    member,
    fields,
    roles: [{ id: 'active-role', name: 'Active role' }],
    memberIndex: 0,
    onChange: () => {},
  })));
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('fixed role picker visibly retains an unavailable current role', async () => {
  const view = await renderEditor({
    role_id: 'retired-fixed-role',
    role_assignment: { mode: 'fixed' },
  });
  assert.match(
    view.container.querySelector('[data-testid="select-member-role-0"]').textContent,
    /Unavailable role \(retired-fixed-role\) — select a replacement/,
  );
  await view.cleanup();
});

test('answer mapping and fallback pickers visibly retain unavailable current roles', async () => {
  const field = {
    id: 'membership-type',
    type: 'select',
    label: 'Membership type',
    options: ['Student'],
  };
  const view = await renderEditor({
    role_assignment: {
      mode: 'from_field',
      source_field_id: field.id,
      value_to_role_id: { Student: 'retired-mapped-role' },
      fallback: 'fixed',
      fallback_role_id: 'retired-fallback-role',
    },
  }, [field]);

  assert.match(
    view.container.querySelector('[data-testid="select-member-role-map-0-Student"]').textContent,
    /Unavailable role \(retired-mapped-role\) — select a replacement/,
  );
  assert.match(
    view.container.querySelector('[data-testid="select-member-role-fallback-role-0"]').textContent,
    /Unavailable role \(retired-fallback-role\) — select a replacement/,
  );
  await view.cleanup();
});