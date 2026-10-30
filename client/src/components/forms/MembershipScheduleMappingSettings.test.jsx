import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://test.invalid/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'DocumentFragment', 'Element', 'Node', 'MutationObserver', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const Component = (await import('./MembershipScheduleMappingSettings.jsx')).default;
const mapping = { source_field_id: 'class', entries: [
  { value: 'Associate', config_id: 'associate' },
  { value: 'Overseas associate', config_id: 'overseas' },
] };
async function mount(props = {}) {
  const changes = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const base = { field: { id: 'payment', membership_schedule_mapping: mapping },
    allFields: [{ id: 'class', type: 'radio', label: 'Member Class', options: ['Associate', 'Overseas associate'] }],
    tierConfigs: [
      { id: 'associate', name: 'Associate schedule', structure_scope_type: 'member', is_active: true },
      { id: 'overseas', name: 'Overseas schedule', structure_scope_type: 'member', is_active: true },
      { id: 'inactive', name: 'Old schedule', structure_scope_type: 'member', is_active: false },
      { id: 'org', name: 'Organisation schedule', structure_scope_type: 'organization', is_active: true },
    ], onChange: patch => changes.push(patch), ...props };
  await act(async () => { root.render(<form><Component {...base} /></form>); });
  return { host, changes, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test('saved source and each answer have independent schedule controls', async () => {
  const view = await mount();
  assert.equal(view.host.querySelectorAll('[role="combobox"]').length, 3);
  assert.match(view.host.textContent, /Member Class/);
  assert.match(view.host.textContent, /Associate schedule/);
  assert.match(view.host.textContent, /Overseas schedule/);
  assert.doesNotMatch(view.host.textContent, /Old schedule|Organisation schedule/);
  assert.deepEqual(view.changes, []);
  await view.close();
});
test('incomplete and unavailable schedules are visible without erasing saved mappings', async () => {
  for (const props of [
    { field: { id: 'payment', membership_schedule_mapping: { source_field_id: 'class', entries: [] } } },
    { tierConfigs: [], error: 'Could not load schedules' },
    { tierConfigs: [], loading: true },
    { allFields: [] },
  ]) {
    const view = await mount(props);
    assert.deepEqual(view.changes, []);
    assert.match(view.host.textContent, /unmapped|not mapped|Select a schedule|load|source|Source|Loading/i);
    await view.close();
  }
});
test('turning mapping off emits null rather than an implicit replacement schedule', async () => {
  const view = await mount();
  await act(async () => view.host.querySelector('[role="checkbox"]').click());
  assert.deepEqual(view.changes, [{ membership_schedule_mapping: null }]);
  await view.close();
});
