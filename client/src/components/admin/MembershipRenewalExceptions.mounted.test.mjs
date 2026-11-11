import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync } from 'node:fs';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://isolated.example.test' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { act } = React;
const { createRoot } = await import('react-dom/client');
let handler;
const calls = [];
globalThis.__renewalTestFetch = async (...args) => {
  calls.push(args);
  return handler(...args);
};
after(() => { delete globalThis.__renewalTestFetch; dom.window.close(); });

const bundle = await build({
  entryPoints: ['client/src/components/admin/MembershipRenewalJourneySettings.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{
    name: 'isolated-renewal',
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/adminFetch$/ }, () => ({ path: 'fetch', namespace: 'mock-fetch' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock-fetch' }, () => ({
        contents: 'export const adminFetch = (...args) => globalThis.__renewalTestFetch(...args);',
      }));
      builder.onResolve({ filter: /^@\// }, args => {
        const base = `${process.cwd()}/client/src/${args.path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`, `${base}.tsx`, `${base}.ts`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/renewal-exceptions-fixture.cjs`);
compiled.filename = `${process.cwd()}/renewal-exceptions-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Settings = compiled.exports.default;
const roleId = 'role-current';
const fieldId = 'class-field';
const fixture = (rules = [], revision = 3) => ({
  settings: { mode: 'same_schedule', revision: 8, form_id: null, post_grace_form_id: null },
  forms: [{ id: 'form-active', name: 'Renewal questions' }],
  roles: [{ id: roleId, name: 'Ordinary member' }],
  classes: [{ fieldId, value: 'associate', label: 'Associate' }],
  exceptionsAvailable: true,
  exceptions: { revision, rules },
});
const rule = patch => ({
  id: '4e062015-f088-4620-961d-c3dc3ec0a2c1', matchType: 'membership_class', roleId: null,
  fieldId, classValue: 'associate', route: 'same_schedule', formId: null, restrictToClass: false, ...patch,
});
const response = (body, ok = true) => ({ ok, json: async () => body });
const button = text => [...document.querySelectorAll('button')].find(el => el.textContent === text);
const section = () => document.querySelector('[aria-labelledby="renewal-exceptions-title"]');
const click = async text => {
  assert.ok(button(text), `Missing button: ${text}`);
  await act(async () => button(text).click());
};
const choose = async (element, value) => {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
};
async function mount(props = {}) {
  calls.length = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async next => act(async () => root.render(React.createElement(Settings, { tenantId: 'tenant-a', ...next })));
  await render(props);
  return { render, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test('add, edit, save and remove use pickers and the separate exception revision', async () => {
  let stored = fixture();
  handler = async (_url, options) => {
    if (options.method === 'PUT') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.action, 'save_exceptions');
      assert.equal(payload.expectedRevision, stored.exceptions.revision);
      stored = { ...stored, exceptions: { revision: stored.exceptions.revision + 1, rules: payload.rules } };
    }
    return response(stored);
  };
  const mounted = await mount();
  try {
    assert.match(section().textContent, /No renewal exceptions/);
    await click('Add exception');
    assert.equal(button('Save exceptions').disabled, true);
    await choose(section().querySelectorAll('select')[1], JSON.stringify([fieldId, 'associate']));
    await choose(section().querySelectorAll('select')[2], 'questionnaire');
    await choose(section().querySelectorAll('select')[3], 'form-active');
    await act(async () => section().querySelector('input[type="checkbox"]').click());
    await click('Save exceptions');
    assert.equal(stored.exceptions.rules[0].restrictToClass, true);
    assert.equal(stored.exceptions.rules[0].formId, 'form-active');
    assert.equal(stored.exceptions.rules[0].matchType, 'membership_class');
    assert.match(stored.exceptions.rules[0].id, /^[a-f0-9-]{36}$/);
    assert.match(section().textContent, /Renewal exceptions saved/);
    await click('Remove exception 1');
    assert.equal(stored.exceptions.rules.length, 1);
    await click('Confirm removal');
    await click('Save exceptions');
    assert.deepEqual(stored.exceptions.rules, []);
    assert.ok(calls.every(([, , tenant]) => tenant === 'tenant-a'));
  } finally { await mounted.cleanup(); }
});

test('unavailable saved choices remain visible and block saves until removed or replaced', async () => {
  handler = async () => response(fixture([rule({ matchType: 'role', roleId: 'deleted-role', route: 'questionnaire', formId: 'deleted-form' })]));
  const mounted = await mount();
  try {
    assert.match(section().textContent, /Saved role is unavailable/);
    assert.match(section().textContent, /Saved form is unavailable/);
    await act(async () => section().querySelector('input[type="checkbox"]').click());
    assert.equal(button('Save exceptions').disabled, true);
    await choose(section().querySelectorAll('select')[1], roleId);
    await choose(section().querySelectorAll('select')[3], 'form-active');
    assert.equal(button('Save exceptions').disabled, false);
  } finally { await mounted.cleanup(); }
});

test('revision conflicts preserve edits; reload requires discard confirmation', async () => {
  handler = async (_url, options) => options.method === 'PUT'
    ? response({ error: 'Settings changed. Reload and try again.' }, false)
    : response(fixture([rule()]));
  const mounted = await mount();
  try {
    await act(async () => section().querySelector('input[type="checkbox"]').click());
    await click('Save exceptions');
    assert.match(section().querySelector('[role="alert"]').textContent, /Settings changed/);
    assert.equal(section().querySelector('input').checked, true);
    await click('Reload exceptions');
    assert.equal(section().querySelector('input').checked, true);
    await click('Keep editing');
    await click('Reload exceptions');
    await click('Discard changes and reload');
    assert.equal(section().querySelector('input').checked, false);
  } finally { await mounted.cleanup(); }
});

test('unavailable capability fails closed and joining does not render or load exceptions', async () => {
  handler = async () => response({ ...fixture([rule()]), exceptionsAvailable: false });
  const mounted = await mount();
  try {
    assert.equal(section().querySelector('fieldset').disabled, true);
    assert.equal(button('Save exceptions').disabled, true);
    await mounted.render({ joining: true });
    assert.equal(section(), null);
    const joiningCalls = calls.filter(([url]) => url.includes('joining'));
    assert.equal(joiningCalls.length, 1);
    assert.match(document.body.textContent, /Save joining journey/);
  } finally { await mounted.cleanup(); }
});

test('late responses from another tenant never populate current exception choices', async () => {
  let resolveOld;
  const pending = new Promise(resolve => { resolveOld = resolve; });
  handler = async (_url, _options, tenant) => tenant === 'tenant-a'
    ? pending : response(fixture([rule({ matchType: 'role', roleId })]));
  const mounted = await mount();
  try {
    assert.equal(button('Save exceptions').disabled, true);
    await mounted.render({ tenantId: 'tenant-b' });
    assert.match(section().textContent, /Ordinary member/);
    await act(async () => resolveOld(response({ ...fixture(), roles: [{ id: 'old', name: 'Old tenant role' }] })));
    assert.doesNotMatch(section().textContent, /Old tenant role/);
    assert.match(section().textContent, /Ordinary member/);
  } finally { await mounted.cleanup(); }
});

test('default journey save retains the original request contract', async () => {
  handler = async () => response(fixture());
  const mounted = await mount();
  try {
    await click('Save renewal journey');
    const put = calls.find(([, options]) => options.method === 'PUT');
    assert.deepEqual(JSON.parse(put[1].body), {
      mode: 'same_schedule', postGraceFormId: null, formId: null, expectedRevision: 8,
    });
  } finally { await mounted.cleanup(); }
});

test('direct renewal accepts an optional destination and preserves it across route changes', async () => {
  let stored = fixture([rule()]);
  handler = async (_url, options) => {
    if (options.method === 'PUT') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.action, 'save_exceptions');
      stored = { ...stored, exceptions: { revision: stored.exceptions.revision + 1, rules: payload.rules } };
    }
    return response(stored);
  };
  const mounted = await mount();
  try {
    assert.match(section().textContent, /payment-only renewal form here, not a questionnaire/);
    const picker = () => section().querySelectorAll('select')[3];
    assert.equal(picker().required, false);
    assert.equal(picker().value, '');
    await choose(picker(), 'form-active');
    await choose(section().querySelectorAll('select')[2], 'questionnaire');
    assert.equal(picker().value, 'form-active');
    assert.equal(picker().required, true);
    await choose(section().querySelectorAll('select')[2], 'same_schedule');
    assert.equal(picker().value, 'form-active');
    await click('Save exceptions');
    assert.equal(stored.exceptions.rules[0].route, 'same_schedule');
    assert.equal(stored.exceptions.rules[0].formId, 'form-active');
    await choose(picker(), '');
    await click('Save exceptions');
    assert.equal(stored.exceptions.rules[0].formId, null);
    await choose(section().querySelectorAll('select')[2], 'questionnaire');
    assert.equal(button('Save exceptions').disabled, true);
  } finally { await mounted.cleanup(); }
});

test('unavailable direct destinations stay visible and block save until replaced or cleared', async () => {
  handler = async () => response(fixture([rule({ formId: 'archived-payment-form' })]));
  const mounted = await mount();
  try {
    const picker = () => section().querySelectorAll('select')[3];
    assert.equal(picker().value, 'archived-payment-form');
    assert.match(section().textContent, /Saved form is unavailable/);
    await act(async () => section().querySelector('input[type="checkbox"]').click());
    assert.equal(button('Save exceptions').disabled, true);
    await choose(section().querySelectorAll('select')[2], 'questionnaire');
    assert.equal(picker().value, 'archived-payment-form');
    await choose(section().querySelectorAll('select')[2], 'same_schedule');
    assert.equal(picker().value, 'archived-payment-form');
    await choose(picker(), 'form-active');
    assert.equal(button('Save exceptions').disabled, false);
    await choose(picker(), '');
    assert.equal(button('Save exceptions').disabled, false);
  } finally { await mounted.cleanup(); }
});
