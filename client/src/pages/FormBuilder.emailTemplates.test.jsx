import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
const { window } = dom;
for (const name of ['document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element',
  'DocumentFragment', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle',
  'localStorage', 'sessionStorage', 'location', 'history']) {
  Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLElement.prototype.scrollIntoView = () => {};
Module._extensions['.css'] = () => {};
const source = await readFile('client/src/pages/FormBuilder.jsx', 'utf8');
// Exercise the actual contract picker JSX/callbacks without authenticated page queries.
const contractPickers = [...source.matchAll(/<FormBuilderEmailTemplatePicker[\s\S]*?\/>/g)]
  .slice(1).map(match => match[0]);
const bundle = await build({
  stdin: { contents: `import React from 'react';
    import FormBuilderEmailTemplatePicker from './client/src/components/forms/FormBuilderEmailTemplatePicker.jsx';
    export function ContractPickers({formData, setFormData, emailTemplates}) {
      const idx = 0;
      const reminder = formData.contract_settings.reminders[idx];
      return <>${contractPickers.join('\n')}</>;
    }
    export { EmailCard } from './client/src/pages/FormBuilder.jsx';
    export { default as Picker, alphabeticalTemplates } from './client/src/components/forms/FormBuilderEmailTemplatePicker.jsx';`,
  resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const mod = new Module(`${process.cwd()}/email-picker-test.cjs`);
mod.filename = `${process.cwd()}/email-picker-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const { Picker, EmailCard, ContractPickers, alphabeticalTemplates } = mod.exports;
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
after(() => dom.window.close());
const templates = Object.freeze([
  { id: 'z', name: 'Zulu' }, { id: 'b', name: 'beta' }, { id: 'a', name: 'Alpha' },
  { id: 'a2', name: 'alpha' }, { id: 'u', name: null }, { id: 'ab', name: 'alphabet' },
]);
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function click(element) {
  assert.ok(element);
  await act(async () => { element.click(); await tick(); });
}
async function search(text) {
  const input = document.querySelector('[cmdk-input]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
  });
}
const options = () => [...document.querySelectorAll('[cmdk-item]')];
async function mount(t, initial = { template_id: 'a', field_mapping: { custom: 'field' } }, card = false) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let state;
  const changes = [];
  function Harness() {
    const [email, setEmail] = React.useState({ id: 'fixture', recipient: '', ...initial });
    state = email;
    const update = patch => { changes.push(patch); setEmail(old => ({ ...old, ...patch })); };
    return card
      ? React.createElement(EmailCard, { email, index: 0, emailTemplates: templates, formFields: [],
        onUpdate: update, onRemove() {} })
      : React.createElement(React.Fragment, null, ...['first', 'second'].map(id => React.createElement(Picker, {
        key: id, templates, value: email.template_id, onChange: value => update({ template_id: value }),
        emptyLabel: 'No template', testId: id,
      })));
  }
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { container, changes, get state() { return state; },
    open: () => click(container.querySelector('[data-testid="' + (card ? 'select-email-template-fixture' : 'first') + '"]')) };
}

test('sort is case-insensitive, stable for duplicate names, safe for absent names, and non-mutating', () => {
  assert.deepEqual(alphabeticalTemplates(templates).map(t => t.id), ['a', 'a2', 'ab', 'b', 'u', 'z']);
  assert.equal(templates[0].id, 'z');
});

test('search keeps alphabetical order, clears, has no results feedback and keeps picker state independent', async t => {
  const view = await mount(t);
  await view.open();
  assert.deepEqual(options().map(o => o.textContent), ['No template', 'Alpha', 'alpha', 'alphabet', 'beta', 'Unnamed template', 'Zulu']);
  await search('ALP');
  assert.deepEqual(options().map(o => o.textContent), ['Alpha', 'alpha', 'alphabet']);
  await search('missing');
  assert.equal(options().length, 0);
  assert.match(document.body.textContent, /No templates found/);
  await search('');
  assert.equal(options().length, 7);
  await search('Zulu');
  await act(async () => {
    document.querySelector('[cmdk-input]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
  });
  assert.deepEqual(view.changes, []);
  await click(view.container.querySelector('[data-testid="second"]'));
  assert.equal(document.querySelector('[cmdk-input]').value, '');
  assert.equal(options().length, 7);
});

test('duplicate names select their own ID, keyboard selection works, null is explicit, serialized reload retains label', async t => {
  const view = await mount(t);
  await view.open();
  await click(document.querySelector('[data-testid="first-option-a2"]'));
  assert.equal(view.state.template_id, 'a2');
  await view.open();
  await search('ZUL');
  await act(async () => {
    const input = document.querySelector('[cmdk-input]');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
  });
  assert.equal(view.state.template_id, 'z');
  const reopened = await mount(t, JSON.parse(JSON.stringify(view.state)));
  assert.equal(reopened.container.querySelector('[data-testid="first"]').textContent, 'Zulu');
  assert.deepEqual(reopened.changes, []);
  await view.open();
  await click(options()[0]);
  assert.equal(view.state.template_id, null);
});

test('real submission EmailCard only resets mappings on a changed template, including clearing', async t => {
  const view = await mount(t, undefined, true);
  await view.open();
  await search('Alpha');
  assert.deepEqual(view.state.field_mapping, { custom: 'field' });
  await click(document.querySelector('[data-testid="select-email-template-fixture-option-a"]'));
  assert.deepEqual(view.changes, []);
  assert.deepEqual(view.state.field_mapping, { custom: 'field' });
  await view.open();
  await click(document.querySelector('[data-testid="select-email-template-fixture-option-b"]'));
  assert.equal(view.state.template_id, 'b');
  assert.deepEqual(view.state.field_mapping, {});
  await view.open();
  await click(options()[0]);
  assert.equal(view.state.template_id, null);
  assert.deepEqual(view.changes.at(-1), { template_id: null, field_mapping: {} });
});

test('all four builder selectors use the shared picker and existing load/save preserves template data', async () => {
  assert.equal((source.match(/<FormBuilderEmailTemplatePicker/g) || []).length, 4);
  assert.match(source, /return \(templates \|\| \[\]\)\.filter\(t => t\.is_active !== false\)/);
  assert.match(source, /submission_emails: existingForm.submission_emails\?\.length > 0\s*\? existingForm.submission_emails/);
  assert.match(source, /contract_settings: existingForm.contract_settings \|\|/);
  for (const key of ['initial_email_template_id', 'timeout_email_template_id']) {
    assert.match(source, new RegExp(`${key}: value\\s`));
  }
});

test('actual contract callbacks preserve IDs and nulls through builder save/load and reopened pickers', async t => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let state = {
    submission_emails: [{ id: 'fixture', template_id: 'a2', field_mapping: { custom: 'field' } }],
    contract_settings: {
      initial_email_template_id: 'a', timeout_email_template_id: 'b',
      timeout_days: 30, reminders: [{ id: 'r', days_before_timeout: 3, email_template_id: 'z' }],
    },
  };
  const changes = [];
  async function render() {
    await act(async () => root.render(React.createElement(ContractPickers, {
      formData: state, emailTemplates: templates,
      setFormData(next) { changes.push(next); state = next; },
    })));
  }
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await render();
  const ids = ['select-initial-email-template', 'select-reminder-template-0', 'select-timeout-email-template'];
  for (const id of ids) {
    await click(container.querySelector(`[data-testid="${id}"]`));
    await search('ALPHA');
    await click(document.querySelector(`[data-testid="${id}-option-a2"]`));
    await render();
  }
  assert.equal(state.contract_settings.initial_email_template_id, 'a2');
  assert.equal(state.contract_settings.timeout_email_template_id, 'a2');
  assert.equal(state.contract_settings.reminders[0].email_template_id, 'a2');
  assert.equal(state.contract_settings.reminders[0].days_before_timeout, 3);
  assert.equal(state.contract_settings.timeout_days, 30);
  const saveDeclaration = source.match(/const \{ _ccCustomMode, _bccCustomMode, \.\.\.dataToSave \} = formData;/)[0];
  const save = new Function('formData', `${saveDeclaration} return dataToSave;`);
  const submissionLoad = source.slice(source.indexOf('submission_emails: existingForm.submission_emails'),
    source.indexOf('prefill_source: existingForm.prefill_source'));
  const contractLoad = source.slice(source.indexOf('contract_settings: existingForm.contract_settings'),
    source.indexOf('communication_category_id: existingForm.communication_category_id'));
  const load = new Function('existingForm', `return {${submissionLoad}${contractLoad}};`);
  const saved = JSON.parse(JSON.stringify(save(state)));
  state = load(saved);
  assert.deepEqual(state, saved);
  // Remount instead of merely rerendering to discard all transient picker state.
  await act(async () => root.render(null));
  await render();
  for (const id of ids) {
    assert.equal(container.querySelector(`[data-testid="${id}"]`).textContent, 'alpha');
    await click(container.querySelector(`[data-testid="${id}"]`));
    await click(document.querySelector(`[data-testid="${id}-option-a2"]`));
  }
  assert.equal(changes.length, 3, 'reselecting never calls a contract update');
  for (const id of ids) {
    await click(container.querySelector(`[data-testid="${id}"]`));
    await click(options()[0]);
    await render();
  }
  assert.equal(state.contract_settings.initial_email_template_id, null);
  assert.equal(state.contract_settings.timeout_email_template_id, null);
  assert.equal(state.contract_settings.reminders[0].email_template_id, null);
});
