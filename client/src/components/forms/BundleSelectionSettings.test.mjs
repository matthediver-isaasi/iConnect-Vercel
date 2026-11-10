import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { captureFormEditorBaseline, prepareFormEditorUpdate, formEditorPatch } from '../../lib/formEditorSave.js';

const compiled = await build({
  stdin: { contents: `export {default} from "./client/src/components/forms/BundleSelectionSettings.jsx"; export {state} from "@/pages/sales/useCatalogue";`, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{
    name: 'boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
        contents: args.path.includes('useCatalogue')
          ? 'export const state = {}; export const useCatalogue = () => state;'
          : 'export const Button = "button"; export const Checkbox = "input";',
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/bundle-settings-test.cjs`);
mod.filename = `${process.cwd()}/bundle-settings-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, mod.filename);
const { default: Settings, state } = mod.exports;
function render(rows, selected = [], flags = {}) {
  Object.assign(state, { data: rows, isPending: false, isError: false }, flags);
  const calls = [];
  const tree = Settings({ field: { allowed_bundle_ids: selected }, onChange: ids => calls.push(ids) });
  const buttons = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button') buttons.push(node);
    [node.props?.children].flat(Infinity).forEach(walk);
  }
  walk(tree);
  return { buttons, calls };
}
test('select all adds active bundles, preserves saved selections and never submits the form', () => {
  const { buttons, calls } = render([{ id: 'a' }, { id: 'b' }, { id: 'c', isActive: false }, { id: 'd', archivedAt: '2026-01-01' }], ['missing', 'a']);
  assert.equal(buttons[0].props.type, 'button');
  buttons[0].props.onClick();
  assert.deepEqual(calls[0], ['missing', 'a', 'b']);
  buttons[1].props.onClick();
  assert.deepEqual(calls[1], []);
});
test('select all respects the 100 bundle cap', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: `${i}` }));
  const { buttons, calls } = render(rows, ['119']);
  buttons[0].props.onClick();
  assert.equal(calls[0].length, 100);
  assert.equal(calls[0][0], '119');
  assert.equal(new Set(calls[0]).size, 100);
});
test('bulk selection is disabled when unavailable, full, or already selected', () => {
  for (const [rows, selected, flags] of [
    [[], [], {}], [[{ id: 'a' }], ['a'], {}],
    [[{ id: 'a' }], [], { isPending: true }],
    [[{ id: 'a' }], [], { isError: true }],
    [[{ id: 'a' }], Array.from({ length: 100 }, (_, i) => `${i}`), {}],
  ]) assert.equal(render(rows, selected, flags).buttons[0].props.disabled, true);
  assert.equal(render([], []).buttons[1].props.disabled, true);
});
test('stock setting defaults on and round-trips explicit false and true', () => {
  Object.assign(state, { data: { items: [], stockOptionReady: true }, isPending: false, isError: false });
  let field = { allowed_bundle_ids: [] };
  const checkbox = () => {
    const tree = Settings({ field, onChange() {}, onStockReductionChange(value) {
      field = JSON.parse(JSON.stringify({ ...field, reduce_bundle_stock_on_submission: value }));
    } });
    return tree.props.children.find(node => node?.type === 'label').props.children[0];
  };
  assert.equal(checkbox().props.checked, true);
  assert.equal(checkbox().props.disabled, false);
  checkbox().props.onCheckedChange(false);
  assert.equal(field.reduce_bundle_stock_on_submission, false);
  assert.equal(checkbox().props.checked, false);
  checkbox().props.onCheckedChange(true);
  assert.equal(checkbox().props.checked, true);
});
test('stock option stays disabled until migrated capability is confirmed', () => {
  for (const data of [[], { items: [] }, { items: [], stockOptionReady: false }]) {
    Object.assign(state, { data, isPending: false, isError: false });
    const tree = Settings({ field: {}, onChange() {} });
    const checkbox = tree.props.children.find(node => node?.type === 'label').props.children[0];
    assert.equal(checkbox.props.disabled, true);
    assert.equal(checkbox.props.checked, true);
  }
});
test('builder save patch and reopened baseline preserve both stock settings', () => {
  let persisted = { fields: [{ id: 'bundle', type: 'sales_bundle', allowed_bundle_ids: [] }] };
  for (const policy of [false, true, false]) {
    const baseline = captureFormEditorBaseline(persisted, persisted);
    const editor = { ...persisted, fields: [{ ...persisted.fields[0], reduce_bundle_stock_on_submission: policy }] };
    const patch = formEditorPatch(prepareFormEditorUpdate(editor, baseline), baseline);
    assert.equal(patch.fields[0].reduce_bundle_stock_on_submission, policy);
    persisted = JSON.parse(JSON.stringify({ ...persisted, ...patch }));
    const reopened = captureFormEditorBaseline(persisted, persisted);
    assert.equal(reopened.editor.fields[0].reduce_bundle_stock_on_submission, policy);
  }
});
