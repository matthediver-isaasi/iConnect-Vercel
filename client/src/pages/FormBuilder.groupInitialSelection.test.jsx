import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFile } from 'node:fs/promises';
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
const bundledModule = new Module(`${process.cwd()}/form-builder-group-test-memory.cjs`);
bundledModule.filename = `${process.cwd()}/form-builder-group-test-memory.cjs`;
bundledModule.paths = Module._nodeModulePaths(process.cwd());
bundledModule._compile(bundle.outputFiles[0].text, bundledModule.filename);
const {
  OrganizationGroupInitialSelectionEditor,
  RepeatableRowsSettings,
  organizationGroupInitialSelectionError,
} = bundledModule.exports;
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const source = await readFile(new URL('./FormBuilder.jsx', import.meta.url), 'utf8');

// Local-only fixture IDs: these tests never call a live form or entity API.
const GROUP_A = '11111111-1111-4111-8111-111111111111';
const GROUP_B = '22222222-2222-4222-8222-222222222222';
const groups = [{ id: GROUP_A, name: 'North' }, { id: GROUP_B, name: 'South' }];
const baseField = { id: 'group', type: 'organisation_group_dropdown', label: 'Group' };

after(() => dom.window.close());

async function mount(t, initialField, { repeatable = false, organizationGroups = groups } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const changes = [];
  let currentField;
  function Harness({ availableGroups }) {
    const [field, setField] = React.useState(initialField);
    currentField = field;
    const update = updates => {
      changes.push(updates);
      setField(current => ({ ...current, ...updates }));
    };
    return React.createElement('form', null,
      repeatable
        ? React.createElement(RepeatableRowsSettings, {
          field, originalIndex: 0, allFields: [field], organizationGroups: availableGroups,
          updateField: (index, updates) => {
            assert.equal(index, 0);
            update(updates);
          },
        })
        : React.createElement(OrganizationGroupInitialSelectionEditor, {
          field, organizationGroups: availableGroups, onChange: update,
        }));
  }
  const render = async availableGroups => {
    await act(async () => root.render(React.createElement(Harness, { availableGroups })));
  };
  await render(organizationGroups);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    container, changes, render,
    get field() { return currentField; },
  };
}

function picker(view, prefix = 'group', kind = 'mode') {
  const trigger = view.container.querySelector(
    `[data-testid="select-group-initial-selection-${kind}-${prefix}"]`,
  );
  assert.ok(trigger, `${kind} selector is rendered`);
  const select = trigger.parentElement.querySelector('select');
  assert.ok(select, 'Radix exposes the native form select');
  return select;
}

async function choose(select, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

async function spuriousEmpty(select) {
  const option = document.createElement('option');
  option.value = '';
  select.appendChild(option);
  await choose(select, '');
  option.remove();
}

test('absent initial selection shows exactly None, Specific group and From URL parameter without writing a default', async t => {
  const view = await mount(t, baseField);
  const select = picker(view);
  assert.equal(select.value, 'none');
  assert.deepEqual(Array.from(select.options, option => [option.value, option.textContent]), [
    ['none', 'None'], ['specific', 'Specific group'], ['url', 'From URL parameter'],
  ]);
  assert.deepEqual(view.changes, []);
  await spuriousEmpty(select);
  assert.deepEqual(view.changes, []);
  assert.equal(view.field.group_initial_selection, undefined);
});

test('specific selection uses loaded tenant groups and modes remove the group ID when not applicable', async t => {
  const view = await mount(t, baseField);
  await choose(picker(view), 'specific');
  assert.deepEqual(view.field.group_initial_selection, { mode: 'specific' });
  assert.match(view.container.textContent, /Choose a group before saving/);
  assert.deepEqual(Array.from(picker(view, 'group', 'group').options, option => option.value), [
    '__choose_group__', GROUP_A, GROUP_B,
  ]);
  await choose(picker(view, 'group', 'group'), GROUP_B);
  assert.deepEqual(view.field.group_initial_selection, { mode: 'specific', group_id: GROUP_B });
  await choose(picker(view), 'url');
  assert.deepEqual(view.field.group_initial_selection, { mode: 'url' });
  assert.equal(view.container.querySelector('[data-testid="select-group-initial-selection-group-group"]'), null);
  assert.match(view.container.textContent, /fixed URL parameter group_id/);
  assert.match(view.container.textContent, /\?group_id=<group UUID>/);
  await choose(picker(view), 'none');
  assert.deepEqual(view.field.group_initial_selection, { mode: 'none' });
});

test('saved specific selection survives spurious native empties and async option hydration', async t => {
  const view = await mount(t, {
    ...baseField, group_initial_selection: { mode: 'specific', group_id: GROUP_A },
  }, { organizationGroups: [] });
  assert.match(view.container.textContent, /Unavailable group/);
  await spuriousEmpty(picker(view));
  await spuriousEmpty(picker(view, 'group', 'group'));
  assert.deepEqual(view.changes, []);
  assert.deepEqual(view.field.group_initial_selection, { mode: 'specific', group_id: GROUP_A });
  await view.render(groups);
  assert.match(view.container.querySelector('[data-testid="select-group-initial-selection-group-group"]').textContent, /North/);
  await spuriousEmpty(picker(view, 'group', 'group'));
  assert.deepEqual(view.changes, []);
  await choose(picker(view, 'group', 'group'), GROUP_B);
  assert.deepEqual(view.field.group_initial_selection, { mode: 'specific', group_id: GROUP_B });
});

test('saved URL mode is hydrated without clearing or adding a group ID', async t => {
  const view = await mount(t, {
    ...baseField, group_initial_selection: { mode: 'url' },
  });
  await spuriousEmpty(picker(view));
  assert.deepEqual(view.changes, []);
  assert.deepEqual(view.field.group_initial_selection, { mode: 'url' });
});

for (const shape of ['children', 'child_fields', 'repeatable_row']) {
  test(`repeatable ${shape} children can edit initial selection and retain it through serialized reload`, async t => {
    const children = [
      { ...baseField, group_initial_selection: { mode: 'specific', group_id: GROUP_A } },
      { id: 'notes', type: 'text', label: 'Notes', options: [] },
    ];
    const containerField = {
      id: 'rows', type: 'repeatable_rows', label: 'Rows',
      ...(shape === 'repeatable_row'
        ? { repeatable_row: { version: 1, children } }
        : { [shape]: children }),
    };
    const view = await mount(t, containerField, { repeatable: true });
    await spuriousEmpty(picker(view, 'rows-group', 'group'));
    assert.deepEqual(view.changes, []);
    await choose(picker(view, 'rows-group', 'group'), GROUP_B);
    const saved = JSON.parse(JSON.stringify(view.field));
    const savedChildren = shape === 'repeatable_row' ? saved.repeatable_row.children : saved[shape];
    assert.deepEqual(savedChildren[0].group_initial_selection, { mode: 'specific', group_id: GROUP_B });
    assert.equal(savedChildren[1].label, 'Notes');
    const reloaded = await mount(t, saved, { repeatable: true });
    assert.equal(picker(reloaded, 'rows-group', 'group').value, GROUP_B);
    assert.deepEqual(reloaded.changes, []);
    await choose(picker(reloaded, 'rows-group'), 'url');
    const updatedChildren = shape === 'repeatable_row'
      ? reloaded.field.repeatable_row.children : reloaded.field[shape];
    assert.deepEqual(updatedChildren[0].group_initial_selection, { mode: 'url' });
  });
}

test('save and publish validation checks top-level and repeatable specific UUIDs without requiring an initial selection', () => {
  for (const selection of [undefined, { mode: 'none' }, { mode: 'url' }, { mode: 'specific', group_id: GROUP_A }]) {
    const field = { ...baseField, ...(selection ? { group_initial_selection: selection } : {}) };
    assert.equal(organizationGroupInitialSelectionError([field]), null);
    assert.equal(organizationGroupInitialSelectionError([
      { id: 'rows', type: 'repeatable_rows', child_fields: [field] },
    ]), null);
  }
  for (const selection of [
    { mode: 'specific' }, { mode: 'specific', group_id: 'North' },
    { mode: 'url', group_id: GROUP_A }, { mode: 'none', group_id: GROUP_A },
    { mode: 'unsupported' }, null,
  ]) {
    const field = { ...baseField, group_initial_selection: selection };
    assert.match(organizationGroupInitialSelectionError([field]), /Group/);
    assert.match(organizationGroupInitialSelectionError([
      { id: 'rows', type: 'repeatable_row', repeatable_row: { children: [field] } },
    ]), /Group/);
  }
  assert.equal(
    (source.match(/const groupInitialSelectionError = organizationGroupInitialSelectionError\(formData\.fields\);/g) || []).length,
    2,
    'both normal save and survey publish guard invalid drafts',
  );
});

test('existing builder load and save field transformations preserve all selection modes and children', () => {
  // Evaluate the actual pure field transformations used by the builder, without
  // mounting authenticated queries or making form update requests.
  const loadStart = source.indexOf('existingForm.fields.map(field => (') + 'existingForm.fields.map(field => ('.length;
  const loadEnd = source.indexOf(')) : [],', loadStart);
  assert.ok(loadStart > 0 && loadEnd > loadStart);
  const loadField = new Function('field', `return (${source.slice(loadStart, loadEnd)});`);
  const saveMarker = 'dataToSave.fields = (dataToSave.fields || []).map((f) => {';
  const saveStart = source.indexOf(saveMarker) + saveMarker.length;
  const saveEnd = source.indexOf('\n    });', saveStart);
  assert.ok(saveStart > 0 && saveEnd > saveStart);
  const saveField = new Function('f', source.slice(saveStart, saveEnd));
  for (const selection of [undefined, { mode: 'none' }, { mode: 'specific', group_id: GROUP_A }, { mode: 'url' }]) {
    const field = {
      ...baseField, options: ['', 'kept'],
      ...(selection ? { group_initial_selection: selection } : {}),
    };
    const saved = JSON.parse(JSON.stringify(saveField(loadField(field))));
    assert.deepEqual(saved.group_initial_selection, selection);
    assert.deepEqual(saved.options, ['kept']);
    const container = {
      id: 'rows', type: 'repeatable_rows', repeatable_row: { children: [field] },
    };
    const savedContainer = JSON.parse(JSON.stringify(saveField(loadField(container))));
    assert.deepEqual(savedContainer.repeatable_row.children[0].group_initial_selection, selection);
  }
});