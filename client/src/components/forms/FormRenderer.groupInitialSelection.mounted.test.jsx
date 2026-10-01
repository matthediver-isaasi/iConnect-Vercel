import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import Module from 'node:module';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/groups' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event,
  DocumentFragment: dom.window.DocumentFragment, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
});
window.localStorage.setItem('tenant_slug', 'test-tenant');
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const bundle = await build({
  stdin: {
    contents: "export { default as FormRenderer } from './client/src/components/forms/FormRenderer.jsx'; export { publicClient } from './client/src/api/publicClient.js'; export { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
    resolveDir: process.cwd(), loader: 'js',
  },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const bundledModule = new Module(`${process.cwd()}/group-initial-selection-test.cjs`);
bundledModule.filename = `${process.cwd()}/group-initial-selection-test.cjs`;
bundledModule.paths = Module._nodeModulePaths(process.cwd());
bundledModule._compile(bundle.outputFiles[0].text, bundledModule.filename);
const { FormRenderer, publicClient, QueryClient, QueryClientProvider } = bundledModule.exports;
const originalGroups = publicClient.listFormOrganisationGroupOptions;
const originalOrgs = publicClient.listFormOrganizationOptions;
after(() => {
  publicClient.listFormOrganisationGroupOptions = originalGroups;
  publicClient.listFormOrganizationOptions = originalOrgs;
  dom.window.close();
});
const h = React.createElement;
const groupA = '10000000-0000-4000-8000-000000000001';
const groupB = '10000000-0000-4000-8000-000000000002';
const options = [{ id: groupA, name: 'Group A' }, { id: groupB, name: 'Group B' }];
const group = { id: 'group', type: 'organisation_group_dropdown', label: 'Group', group_initial_selection: { mode: 'specific', group_id: groupA } };
const wait = () => new Promise(resolve => setTimeout(resolve, 5));
async function settle() { for (let i = 0; i < 5; i++) await act(async () => wait()); }

async function mount(props = {}) {
  publicClient.listFormOrganisationGroupOptions = async () => options;
  window.history.replaceState({}, '', '/forms/groups');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const element = document.createElement('div');
  document.body.appendChild(element);
  const root = createRoot(element);
  const changes = [];
  let current = { field: group, formId: 'form', allFields: [group], allFormValues: {}, groupInitialSelectionReady: true, onChange: value => changes.push(value), ...props };
  const render = async (next = {}) => {
    current = { ...current, ...next };
    await act(async () => root.render(h(QueryClientProvider, { client }, h(FormRenderer, current))));
    await settle();
  };
  await render();
  return { element, changes, client, render, cleanup: async () => {
    await act(async () => root.unmount()); client.clear(); element.remove();
  } };
}

test('specific initial selection is once-only, including query refetch and a cleared/deleted answer', async () => {
  const view = await mount();
  try {
    assert.deepEqual(view.changes, [groupA]);
    await view.render({ value: '', allFormValues: { group: '' } });
    await act(async () => view.client.invalidateQueries());
    await settle();
    await view.render({ value: undefined, allFormValues: {} });
    assert.deepEqual(view.changes, [groupA]);
  } finally { await view.cleanup(); }
});

test('legacy none, intentional blanks, existing values, review/read-only and availability probes never write', async () => {
  for (const props of [
    { field: { ...group, group_initial_selection: undefined } },
    { field: { ...group, group_initial_selection: { mode: 'none' } } },
    ...['', null, [], undefined, groupB].map(value => ({ allFormValues: { group: value }, value })),
    { allFormValues: { legacy: '' }, field: { ...group, name: 'legacy' } },
    { disabled: true }, { disabled: true, field: { ...group, locked: true } },
    { field: { ...group, read_only: true } }, { field: { ...group, display_only: true } },
    { groupInitialSelectionReady: false }, { availabilityProbe: true }, { parentHidden: true },
  ]) {
    const view = await mount(props);
    try { assert.deepEqual(view.changes, [], JSON.stringify(props)); }
    finally { await view.cleanup(); }
  }
});

for (const mode of ['specific', 'url']) {
  test(`author-locked ${mode} Group initializes in respondent entry while its control stays locked`, async () => {
    const field = { ...group, locked: true, group_initial_selection: mode === 'url'
      ? { mode: 'url' } : group.group_initial_selection };
    const view = await mount({ field, groupInitialSelectionReady: false });
    try {
      window.history.replaceState({}, '', `/forms/groups?group_id=${groupA}`);
      await view.render({ groupInitialSelectionReady: true });
      assert.deepEqual(view.changes, [groupA]);
      await view.render({ value: groupA, allFormValues: { group: groupA } });
      const trigger = view.element.querySelector('[data-testid="select-organisation-group-group"]');
      assert.equal(trigger.disabled, true);
      assert.match(trigger.textContent, /Group A/);
      await view.render({ value: '', allFormValues: { group: '' } });
      assert.deepEqual(view.changes, [groupA]);
    } finally { await view.cleanup(); }
  });

  test(`author-locked ${mode} Group never initializes in a disabled review surface`, async () => {
    const field = { ...group, locked: true, group_initial_selection: mode === 'url'
      ? { mode: 'url' } : group.group_initial_selection };
    const view = await mount({ field, disabled: true, groupInitialSelectionReady: false });
    try {
      window.history.replaceState({}, '', `/forms/groups?group_id=${groupA}`);
      await view.render({ groupInitialSelectionReady: true });
      assert.deepEqual(view.changes, []);
      assert.equal(view.element.querySelector('[data-testid="select-organisation-group-group"]').disabled, true);
    } finally { await view.cleanup(); }
  });

  test(`locked repeatable container distinguishes author locking from surface disablement for ${mode}`, async () => {
    const child = { ...group, group_initial_selection: mode === 'url'
      ? { mode: 'url' } : group.group_initial_selection };
    const field = { id: 'rows', type: 'repeatable_rows', label: 'Rows', locked: true, children: [child] };
    const rows = [{ _row_id: 'locked-row' }];
    for (const disabled of [false, true]) {
      const view = await mount({ field, disabled, value: rows, allFields: [field],
        allFormValues: { rows }, groupInitialSelectionReady: false });
      try {
        window.history.replaceState({}, '', `/forms/groups?group_id=${groupA}`);
        await view.render({ groupInitialSelectionReady: true });
        if (disabled) assert.deepEqual(view.changes, []);
        else assert.equal(view.changes.at(-1)?.[0]?.group, groupA);
        assert.equal(view.element.querySelector('[data-testid="select-organisation-group-group"]').disabled, true);
      } finally { await view.cleanup(); }
    }
  });
}

test('waits for options and readiness; authenticated/draft answers arriving while pending win', async () => {
  const view = await mount({ groupInitialSelectionReady: false });
  try {
    assert.deepEqual(view.changes, []);
    await view.render({ groupInitialSelectionReady: true, value: groupB, allFormValues: { group: groupB } });
    assert.deepEqual(view.changes, []);
  } finally { await view.cleanup(); }
  const pending = await mount({ groupInitialSelectionReady: false });
  try {
    let release;
    publicClient.listFormOrganisationGroupOptions = () => new Promise(resolve => { release = resolve; });
    pending.client.removeQueries();
    await pending.render({ formId: 'pending-form', groupInitialSelectionReady: true });
    assert.deepEqual(pending.changes, []);
    await act(async () => release(options));
    await settle();
    assert.deepEqual(pending.changes, [groupA]);
  } finally { await pending.cleanup(); }
});

test('URL mode reads fixed group_id and rejects missing, malformed, duplicate and non-tenant IDs', async () => {
  for (const [search, expected] of [
    [`?group_id=${groupB}`, [groupB]], ['', []], ['?group_id=bad', []],
    [`?group=${groupA}`, []], [`?group_id=${groupA}&group_id=${groupB}`, []],
    ['?group_id=10000000-0000-4000-8000-000000000003', []],
  ]) {
    const view = await mount({ groupInitialSelectionReady: false, field: { ...group, group_initial_selection: { mode: 'url', group_id: groupA } } });
    try {
      window.history.replaceState({}, '', `/forms/groups${search}`);
      await view.render({ groupInitialSelectionReady: true });
      assert.deepEqual(view.changes, expected);
    } finally { await view.cleanup(); }
  }
});

test('conditional intersection must allow the initial ID; a later rule match can initialize it', async () => {
  const field = { ...group, conditional_filters: { version: 1, rules: [{
    id: 'rule', source_field_id: 'source', operator: 'equals', value: 'yes',
    is_fallback: false, allowed_values: [groupA], org_filter: null,
  }] } };
  const view = await mount({ field, allFields: [field, { id: 'source', type: 'text' }], allFormValues: { source: 'no' } });
  try {
    assert.deepEqual(view.changes, []);
    await view.render({ allFormValues: { source: 'yes' } });
    assert.deepEqual(view.changes, [groupA]);
  } finally { await view.cleanup(); }
});

test('failed option loading does not initialize or erase saved answers and successful retry may initialize', async () => {
  const view = await mount({ groupInitialSelectionReady: false });
  try {
    publicClient.listFormOrganisationGroupOptions = async () => { throw new Error('Groups unavailable'); };
    await view.render({ formId: 'failed-form', groupInitialSelectionReady: true });
    assert.deepEqual(view.changes, []);
    assert.match(view.element.textContent, /Unable to load organisation groups/);
    publicClient.listFormOrganisationGroupOptions = async () => options;
    await act(async () => view.client.invalidateQueries());
    await settle();
    assert.deepEqual(view.changes, [groupA]);
  } finally { await view.cleanup(); }
});

for (const layout of ['cards', 'spreadsheet']) {
  test(`repeatable ${layout} initializes missing cells but preserves stored/user-cleared blanks`, async () => {
    const field = { id: 'rows', type: 'repeatable_rows', label: 'Rows', layout, min_rows: 0, children: [group, { id: 'notes', type: 'text' }] };
    function Harness() {
      const [values, setValues] = React.useState({ rows: [{ _row_id: 'new', notes: 'New' }, { _row_id: 'blank', group: '', notes: 'Stored blank' }] });
      return h(React.Fragment, null,
        h(FormRenderer, { field, value: values.rows, allFields: [field], allFormValues: values, formId: `repeat-${layout}`, groupInitialSelectionReady: true, onChange: rows => setValues({ rows }) }),
        h('output', null, JSON.stringify(values)),
        h('button', { onClick: () => setValues(current => ({ rows: current.rows.map(row => ({ ...row, group: '' })) })) }, 'Clear'));
    }
    const view = await mount({ groupInitialSelectionReady: false });
    try {
      const rootElement = document.createElement('div'); document.body.appendChild(rootElement);
      const root = createRoot(rootElement);
      try {
        await act(async () => root.render(h(QueryClientProvider, { client: view.client }, h(Harness))));
        await settle();
        const values = JSON.parse(rootElement.querySelector('output').textContent);
        assert.equal(values.rows[0].group, groupA);
        assert.equal(values.rows[1].group, '');
        await act(async () => rootElement.querySelector('button:last-child').click());
        await settle();
        assert.equal(JSON.parse(rootElement.querySelector('output').textContent).rows[0].group, '');
      } finally { await act(async () => root.unmount()); rootElement.remove(); }
    } finally { await view.cleanup(); }
  });
}

test('source Group initial selection travels through the normal dependent Organisation option pipeline', async () => {
  const requests = [];
  publicClient.listFormOrganizationOptions = async (_slug, _id, _fieldId, answers) => {
    requests.push(answers);
    return answers.group === groupA ? [{ id: 'org-a', name: 'Organisation A' }] : [];
  };
  const organisation = { id: 'org', type: 'organisation_dropdown', label: 'Organisation', organisation_group_parent_field_id: 'group' };
  function Harness() {
    const [values, setValues] = React.useState({});
    return h(React.Fragment, null, ...[group, organisation].map(field => h(FormRenderer, {
      key: field.id, field, value: values[field.id], formId: 'dependent', allFields: [group, organisation],
      allFormValues: values, groupInitialSelectionReady: true,
      onChange: value => setValues(current => ({ ...current, [field.id]: value })),
    })));
  }
  const view = await mount({ groupInitialSelectionReady: false });
  const element = document.createElement('div'); document.body.appendChild(element); const root = createRoot(element);
  try {
    await act(async () => root.render(h(QueryClientProvider, { client: view.client }, h(Harness))));
    await settle();
    assert.ok(requests.some(answers => answers.group === groupA));
    assert.ok(element.querySelector('[data-testid="select-organisation-org"]'));
  } finally { await act(async () => root.unmount()); element.remove(); await view.cleanup(); }
});

test('repeatable unique children do not double-initialize when rows resolve cached options together', async () => {
  const child = { ...group, unique_across_rows: true };
  const field = { id: 'rows', type: 'repeatable_rows', label: 'Rows', children: [child] };
  const rows = [{ _row_id: 'one' }, { _row_id: 'two' }];
  const view = await mount({ field, value: rows, allFields: [field], allFormValues: { rows } });
  try {
    const result = view.changes.at(-1);
    assert.equal(result.filter(row => row.group === groupA).length, 1);
    assert.equal(result.filter(row => !Object.hasOwn(row, 'group')).length, 1);
  } finally { await view.cleanup(); }
});