import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// Run with: npx tsx --test client/src/components/forms/formSelect.test.jsx
// Bundle only local modules so the CSS import is handled without a Vite server.
// External packages share one React instance; the bundle stays entirely in memory.
const require = createRequire(import.meta.url);
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/select-regression',
  pretendToBeVisual: true,
});
const { window } = dom;
Object.defineProperty(window, 'parent', { value: {} });
Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true });
for (const name of [
  'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'Element', 'DocumentFragment', 'Node', 'NodeFilter', 'Event', 'CustomEvent',
  'MutationObserver', 'getComputedStyle',
]) {
  Object.defineProperty(globalThis, name, {
    value: window[name], configurable: true, writable: true,
  });
}
globalThis.window = window;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.releasePointerCapture = () => {};
window.HTMLElement.prototype.getBoundingClientRect = () => ({
  top: 80, bottom: 116, left: 10, right: 210,
  width: 200, height: 36, x: 10, y: 80, toJSON() {},
});
// Any accidental return to ancestor-scrolling APIs fails these tests.
window.HTMLElement.prototype.scrollIntoView = () => {
  assert.fail('Select focus must scroll only its option list, never ancestor documents');
};
window.scrollTo = () => assert.fail('Select focus must not scroll the iframe window');

const bundle = await build({
  entryPoints: ['client/src/components/forms/formSelect.jsx'],
  bundle: true,
  write: false,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const bundledModule = new Module(`${process.cwd()}/form-select-test-memory.cjs`);
bundledModule.filename = `${process.cwd()}/form-select-test-memory.cjs`;
bundledModule.paths = Module._nodeModulePaths(process.cwd());
bundledModule._compile(bundle.outputFiles[0].text, bundledModule.filename);
const { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } = bundledModule.exports;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const h = React.createElement;

after(() => dom.window.close());

async function settle() {
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
}

async function key(keyValue, target = document.activeElement, extra = {}) {
  const event = new window.KeyboardEvent('keydown', {
    key: keyValue, bubbles: true, cancelable: true, ...extra,
  });
  await act(async () => target.dispatchEvent(event));
  return event;
}

async function mount(t, selectProps = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const changes = [];
  await act(async () => root.render(
    h('form', null,
      h(Select, {
        defaultValue: 'alpha',
        name: 'status',
        onValueChange: value => changes.push(value),
        ...selectProps,
      },
      h(SelectTrigger, { 'aria-label': 'Choose status' },
        h(SelectValue, { placeholder: 'Choose an option' })),
      h(SelectContent, null,
        h(SelectItem, { value: 'alpha' }, 'Alpha label'),
        h(SelectItem, { value: 'beta', disabled: true }, 'Beta disabled'),
        h(SelectItem, { value: 'bravo', textValue: 'Bravo' }, 'Bravo label'),
        h(SelectItem, { value: 'charlie' }, 'Charlie label'),
        h(SelectItem, { value: 'delta' }, 'Delta label')))),
  ));
  t.after(async () => {
    await act(async () => root.unmount());
    await settle();
    container.remove();
  });
  const trigger = container.querySelector('[role="combobox"]');
  return {
    trigger, changes, container,
    async open() {
      await act(async () => trigger.focus());
      await key('ArrowDown', trigger);
      await settle();
      const dialog = document.querySelector('[role="dialog"]');
      assert.ok(dialog, 'insufficient iframe space opens a real Radix dialog');
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(trigger.getAttribute('aria-controls'), dialog.id);
      return dialog;
    },
  };
}

function focusedLabel() {
  return document.activeElement.textContent;
}

test('dialog arrows/Home/End navigate enabled options with a roving tab stop', async t => {
  const picker = await mount(t);
  await picker.open();
  assert.equal(focusedLabel(), 'Alpha label');
  assert.equal(document.activeElement.tabIndex, 0);
  await key('ArrowDown');
  assert.equal(focusedLabel(), 'Bravo label', 'ArrowDown skips disabled Beta');
  await key('ArrowUp');
  assert.equal(focusedLabel(), 'Alpha label');
  await key('End');
  assert.equal(focusedLabel(), 'Delta label');
  await key('ArrowDown');
  assert.equal(focusedLabel(), 'Delta label', 'navigation stops at the end');
  await key('Home');
  assert.equal(focusedLabel(), 'Alpha label');
  assert.equal(document.querySelectorAll('[role="option"][tabindex="0"]').length, 1);
  assert.deepEqual(picker.changes, [], 'navigation alone does not select');
});

test('dialog typeahead skips disabled matches and supports multi-character search', async t => {
  const picker = await mount(t);
  await picker.open();
  await key('b');
  assert.equal(focusedLabel(), 'Bravo label', 'disabled Beta is not a typeahead candidate');
  await key('r');
  assert.equal(focusedLabel(), 'Bravo label', 'textValue is used for continuing search');
  await key('Escape');
  await settle();
  await picker.open();
  await key('c');
  await key('h');
  assert.equal(focusedLabel(), 'Charlie label');
  assert.deepEqual(picker.changes, []);
});

test('Enter selects once and preserves the display label and native form value after close', async t => {
  const picker = await mount(t);
  assert.match(picker.trigger.textContent, /Alpha label/);
  await picker.open();
  await key('ArrowDown');
  await key('Enter');
  await settle();
  assert.deepEqual(picker.changes, ['bravo']);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.match(picker.trigger.textContent, /Bravo label/);
  assert.equal(picker.container.querySelector('select').value, 'bravo');
  assert.equal(document.activeElement, picker.trigger);
  await picker.open();
  assert.equal(focusedLabel(), 'Bravo label', 'reopening focuses the retained selection');
});

test('Space selects a focused option and restores trigger focus', async t => {
  const picker = await mount(t);
  await picker.open();
  await key('End');
  await key(' ');
  await settle();
  assert.deepEqual(picker.changes, ['delta']);
  assert.match(picker.trigger.textContent, /Delta label/);
  assert.equal(document.activeElement, picker.trigger);
});

test('Escape dismisses without changing selection and restores focus', async t => {
  const picker = await mount(t);
  await picker.open();
  await key('End');
  await key('Escape');
  await settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.deepEqual(picker.changes, []);
  assert.match(picker.trigger.textContent, /Alpha label/);
  assert.equal(document.activeElement, picker.trigger);
  assert.equal(picker.trigger.getAttribute('aria-expanded'), 'false');
});

test('mouse selection cannot choose disabled items and retains its selected display label', async t => {
  const picker = await mount(t);
  const dialog = await picker.open();
  const options = dialog.querySelectorAll('[role="option"]');
  await act(async () => options[1].click());
  assert.deepEqual(picker.changes, []);
  assert.ok(document.querySelector('[role="dialog"]'));
  await act(async () => options[3].click());
  await settle();
  assert.deepEqual(picker.changes, ['charlie']);
  assert.match(picker.trigger.textContent, /Charlie label/);
  assert.equal(document.activeElement, picker.trigger);
});

test('Tab reaches the accessible close control through the Radix focus loop', async t => {
  const picker = await mount(t);
  const dialog = await picker.open();
  const close = dialog.querySelector('button[aria-label="Close options"]');
  assert.ok(close);
  assert.equal(close.tabIndex, 0);
  const forward = await key('Tab');
  assert.equal(forward.defaultPrevented, true, 'Radix loops at the active option tab stop');
  assert.equal(document.activeElement, close);
  await key('Tab', close, { shiftKey: true });
  assert.equal(focusedLabel(), 'Alpha label', 'reverse Tab remains within the dialog');
  await key('Tab');
  await act(async () => close.click());
  await settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, picker.trigger);
  assert.deepEqual(picker.changes, []);
});

test('a disabled trigger cannot open the dialog or change the value', async t => {
  const picker = await mount(t, { disabled: true });
  assert.equal(picker.trigger.disabled, true);
  await act(async () => picker.trigger.click());
  await key('ArrowDown', picker.trigger);
  await key('Enter', picker.trigger);
  await key(' ', picker.trigger);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.deepEqual(picker.changes, []);
  assert.match(picker.trigger.textContent, /Alpha label/);
});

test('keyboard focus scrolls only the list, never the iframe or Canvas ancestors', async t => {
  const picker = await mount(t);
  const dialog = await picker.open();
  const list = dialog.querySelector('[role="listbox"]');
  const options = list.querySelectorAll('[role="option"]');
  list.getBoundingClientRect = () => ({ top: 100, bottom: 160 });
  options[4].getBoundingClientRect = () => ({ top: 300, bottom: 332 });
  options[0].getBoundingClientRect = () => ({ top: 60, bottom: 92 });
  document.documentElement.scrollTop = 42;
  await key('End');
  assert.equal(list.scrollTop, 172, 'the option below the visible list scrolls its list down');
  await key('Home');
  assert.equal(list.scrollTop, 132, 'the option above the visible list scrolls its list up');
  assert.equal(document.documentElement.scrollTop, 42, 'ancestor scroll position is untouched');
  document.documentElement.scrollTop = 0;
});