// Run: node --test client/src/pages/MemberGroupManagement.automaticMembership.mounted.test.mjs
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fieldOptionKey } from '../lib/automaticMembership.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://isolated.example.test' });
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'Element', 'Node', 'NodeFilter', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent',
  'MutationObserver', 'DocumentFragment', 'getComputedStyle',
]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.HTMLElement.prototype.hasPointerCapture = () => false;
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
const React = (await import('react')).default;
const { act } = React;
const { createRoot } = await import('react-dom/client');
after(() => dom.window.close());

// Mount the actual page editor and its real Radix controls, not a duplicate
// implementation. No application server, authentication, or API is needed.
const source = readFileSync(new URL('./MemberGroupManagement.jsx', import.meta.url), 'utf8');
const start = source.indexOf('{/* Filter groups (AND/OR editor) */}');
const end = source.indexOf('{/* Preview */}', start);
assert.ok(start > 0 && end > start);
const saveExpression = source.match(/automatic_membership_filter_groups: groupForm\.automatic_membership_enabled\s*\? \(groupForm\.automatic_membership_filter_groups \|\| \[\]\)\s*: \[\]/)?.[0];
assert.ok(saveExpression, 'use the real save payload projection');
const bundle = await build({
  stdin: {
    contents: `
      import React, {useState} from 'react';
      import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
      import {Button} from '@/components/ui/button';
      import {Input} from '@/components/ui/input';
      import {Label} from '@/components/ui/label';
      import {Plus, X} from 'lucide-react';
      import {buildFieldOptions, fieldOptionKey, blankFilterGroup, blankCondition,
        operatorsForDataType, isNullaryOperator, isMultiValueOperator,
        normalizeConditionValue} from '@/lib/automaticMembership';
      export default function Fixture({initial, fields, onSave}) {
        const [groupForm, setGroupForm] = useState(initial);
        const [, setAutoPreviewResult] = useState(null);
        const autoFieldOptions = buildFieldOptions(fields);
        return <>${source.slice(start, end)}
          <button data-testid="save" onClick={() => onSave({${saveExpression}})}>Save</button>
        </>;
      }
    `,
    resolveDir: process.cwd(), loader: 'jsx',
  },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{
    name: 'client-alias',
    setup(builder) {
      builder.onResolve({ filter: /^@\// }, ({ path }) => {
        const base = `${process.cwd()}/client/src/${path.slice(2)}`;
        return { path: [base, `${base}.jsx`, `${base}.js`, `${base}.ts`].find(existsSync) };
      });
    },
  }],
});
const compiled = new Module(`${process.cwd()}/automatic-membership-fixture.cjs`);
compiled.filename = `${process.cwd()}/automatic-membership-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const Fixture = compiled.exports.default;
const byId = id => document.querySelector(`[data-testid="${id}"]`);

const fields = {
  member: { core: [{ key: 'name', label: 'Member Name', data_type: 'text' }] },
  organization: { core: [{ key: 'name', label: 'Organisation Name', data_type: 'text' }] },
  organization_group: {
    core: [{ key: 'name', label: 'Organisation Group Name', data_type: 'text' }],
    custom: [{ key: 'name', label: 'Group Score', data_type: 'number' },
      { key: 'tier:level', label: 'Group Tier', data_type: 'select', options: ['Regional', 'National'] }],
  },
};
const initial = {
  automatic_membership_enabled: true,
  automatic_membership_filter_groups: [{ conditions: [{
    entity_scope: 'organization', field_type: 'core', field_key: 'name',
    data_type: 'text', operator: 'equals', value: 'Old organisation',
  }] }],
};

async function choose(id, label) {
  await act(async () => {
    byId(id).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  const option = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent === label);
  assert.ok(option, `option ${label} exists`);
  await act(async () => option.click());
}

test('real rule editor selects, saves and restores organisation group scope without name collisions', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  let root = createRoot(host);
  let saved;
  const render = async (form) => act(async () => root.render(React.createElement(Fixture, {
    initial: form, fields, onSave: payload => { saved = JSON.parse(JSON.stringify(payload)); },
  })));
  try {
    await render(initial);
    assert.match(byId('select-field-0-0').textContent, /Organisation · Organisation Name/);
    assert.match(byId('text-organisation-group-rule-help').textContent, /primary organisation’s group/);
    assert.match(byId('text-organisation-group-rule-help').textContent, /including empty or negative rules/);
    await choose('select-field-0-0', 'Organisation Group · Organisation Group Name');
    await choose('select-operator-0-0', 'is empty');
    assert.equal(byId('input-value-0-0'), null);
    await act(async () => byId('save').click());
    const condition = saved.automatic_membership_filter_groups[0].conditions[0];
    assert.deepEqual(condition, {
      entity_scope: 'organization_group', field_type: 'core', field_key: 'name',
      data_type: 'text', operator: 'is_empty', value: '',
    });
    assert.notEqual(fieldOptionKey(condition), fieldOptionKey(initial.automatic_membership_filter_groups[0].conditions[0]));
    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ ...initial, ...saved });
    assert.match(byId('select-field-0-0').textContent, /Organisation Group · Organisation Group Name/);
    await choose('select-field-0-0', 'Organisation Group · Group Score');
    assert.equal(byId('input-value-0-0').type, 'number');
    await act(async () => byId('save').click());
    assert.deepEqual(saved.automatic_membership_filter_groups[0].conditions[0], {
      entity_scope: 'organization_group', field_type: 'custom', field_key: 'name',
      data_type: 'number', operator: 'equals', value: '',
    });
    await choose('select-field-0-0', 'Organisation Group · Group Tier');
    await choose('select-value-0-0', 'National');
    await act(async () => byId('save').click());
    assert.deepEqual(saved.automatic_membership_filter_groups[0].conditions[0], {
      entity_scope: 'organization_group', field_type: 'custom', field_key: 'tier:level',
      data_type: 'select', operator: 'equals', value: 'National',
    });
    // Switching back to existing scopes keeps their original behaviour.
    await choose('select-field-0-0', 'Member · Member Name');
    await act(async () => byId('save').click());
    assert.equal(saved.automatic_membership_filter_groups[0].conditions[0].entity_scope, 'member');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
