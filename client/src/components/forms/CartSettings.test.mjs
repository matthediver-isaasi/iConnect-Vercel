import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { cartConfigurationError, formatCartReceipt } from '../../lib/formCart.js';
import { resolveSubmissionToPrepared } from '../../lib/formSubmissionWordExport.js';

const compiled = await build({
  stdin: { contents: 'export {default} from "./client/src/components/forms/CartSettings.jsx"; export {state} from "@/pages/sales/useCatalogue";', resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{
    name: 'catalogue-boundary',
    setup(builder) {
      builder.onResolve({ filter: /^@\/pages\/sales\/useCatalogue$/ }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onResolve({ filter: /^@\/components\/ui\// }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
        contents: args.path.includes('useCatalogue')
          ? 'export const state = {}; export const useCatalogue = kind => state[kind];'
          : 'export const Button = "button"; export const Checkbox = "checkbox"; export const Input = "input";',
      }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/cart-settings-test.cjs`);
mod.filename = `${process.cwd()}/cart-settings-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.outputFiles[0].text, mod.filename);
const { default: Settings, state } = mod.exports;
const productId = '12345678-1234-4234-8234-123456789012';
const bundleId = '12345678-1234-4234-8234-123456789013';
function walk(node, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) node.forEach(child => walk(child, result));
  else { result.push(node); walk(node.props?.children, result); }
  return result;
}
function render(field) {
  const changes = [];
  const nodes = walk(Settings({ field, onChange: patch => changes.push(patch) }));
  return { nodes, changes };
}
test('presentation patches survive serialization without changing allowlists or explicit tax', () => {
  state.products = { data: { items: [] } };
  state.bundles = { data: { items: [] } };
  const original = { allowed_product_ids: [productId], allowed_bundle_ids: [bundleId],
    bundle_tax: { [bundleId]: { treatment: 'standard', rateBps: 1750 } } };
  let field = original;
  for (const display of ['dropdown', 'cards']) {
    let result = render(field);
    const control = result.nodes.find(node => node.props?.['aria-label'] === 'Bundle display');
    assert.equal(control.props.value, field.bundle_display || 'cards');
    control.props.onChange({ target: { value: display } });
    field = { ...field, ...result.changes[0] };
    result = render(field);
    result.nodes.filter(node => node.type === 'checkbox')[1].props.onCheckedChange(true);
    field = JSON.parse(JSON.stringify({ ...field, ...result.changes[0] }));
    assert.equal(field.bundle_display, display);
    assert.equal(field.show_bundle_category, true);
    for (const key of Object.keys(original)) assert.deepEqual(field[key], original[key]);
  }
});
test('only independent products and bundles can be newly selected; unknown saved choices stay removable', () => {
  state.products = { data: { cartStockReady: true, items: [
    { id: productId, name: 'Handbook' },
    { id: 'event', name: 'Event ticket', eventReference: { eventId: 'event-one' } },
    { id: 'space', name: 'Exhibit', spaceRequirementId: 'space-one' },
  ] } };
  state.bundles = { data: { cartStockReady: true, items: [
    { id: bundleId, name: 'Reading pack', items: [{ productId }] },
    { id: 'event-bundle', name: 'Conference pack', items: [{ productId: 'event' }] },
    { id: 'missing-bundle', name: 'Unreadable pack', items: [{ productId: 'missing' }] },
  ] } };
  const { nodes, changes } = render({ allowed_product_ids: ['saved-missing'], allowed_bundle_ids: [] });
  const choices = nodes.filter(node => node.type === 'checkbox').slice(2);
  assert.deepEqual(choices.map(choice => choice.props.disabled), [false, true, true, undefined, false, true, true]);
  const saved = choices.find(choice => choice.props.checked === true);
  saved.props.onCheckedChange(false);
  assert.deepEqual(changes[0], { allowed_product_ids: [] });
});
test('bundle tax is explicit, standard rate starts unset, and zero is a valid deliberate rate', () => {
  state.products = { data: { cartStockReady: true, items: [{ id: productId, name: 'Handbook' }] } };
  state.bundles = { data: { cartStockReady: true, items: [{ id: bundleId, name: 'Reading pack', items: [{ productId }] }] } };
  const field = { id: 'cart', type: 'sales_cart', cart_version: 1, allowed_product_ids: [], allowed_bundle_ids: [bundleId], bundle_tax: {} };
  const form = { form_type: 'standard', fields: [field, { id: 'payment', type: 'payment', price_field_id: 'cart' }] };
  assert.match(cartConfigurationError(form), /explicit valid tax/);
  const { nodes, changes } = render(field);
  const treatment = nodes.find(node => node.props?.['aria-label'] === 'Tax treatment for Reading pack');
  assert.equal(treatment.props.value, '');
  treatment.props.onChange({ target: { value: 'standard' } });
  assert.equal(changes[0].bundle_tax[bundleId].rateBps, null);
  const next = { ...field, ...changes[0] };
  const rate = render(next).nodes.find(node => node.props?.['aria-label'] === 'Tax rate for Reading pack');
  assert.equal(rate.props.value, '');
  const configured = { ...field, bundle_tax: { [bundleId]: { treatment: 'standard', rateBps: 0 } } };
  assert.equal(cartConfigurationError({ ...form, fields: [configured, form.fields[1]] }), null);
});
test('selected bundle maximum is optional, bounded, and preserves other bundle limits', () => {
  state.products = { data: { cartStockReady: true, items: [{ id: productId, name: 'Handbook' }] } };
  state.bundles = { data: { cartStockReady: true, items: [{ id: bundleId, name: 'Reading pack', items: [{ productId }] }] } };
  const field = { allowed_bundle_ids: [bundleId], bundle_max_quantities: { other: 8 } };
  const { nodes, changes } = render(field);
  const max = nodes.find(node => node.props?.['aria-label'] === 'Maximum quantity for Reading pack');
  assert.equal(max.props.value, '');
  assert.equal(max.props.placeholder, '1000');
  for (const value of ['0', '-1', '1001', '1.5']) max.props.onChange({ target: { value } });
  assert.equal(changes.length, 0);
  max.props.onChange({ target: { value: '1' } });
  assert.deepEqual(changes.at(-1), { bundle_max_quantities: { other: 8, [bundleId]: 1 } });
  const updated = render({ ...field, ...changes.at(-1) });
  const updatedMax = updated.nodes.find(node => node.props?.['aria-label'] === 'Maximum quantity for Reading pack');
  assert.equal(updatedMax.props.value, 1);
  updatedMax.props.onChange({ target: { value: '' } });
  assert.deepEqual(updated.changes.at(-1), { bundle_max_quantities: { other: 8 } });
  assert.equal(render({ allowed_bundle_ids: [] }).nodes.some(node => node.props?.['aria-label'] === 'Maximum quantity for Reading pack'), false);
});
test('Word export uses the immutable receipt and hides its internal metadata', () => {
  const receipt = { version: 1, fieldId: 'cart', currency: 'GBP', netMinor: 1735, taxMinor: 347, grossMinor: 2082, lines: [{
    kind: 'product', id: productId, name: 'Original handbook', description: 'Archived edition', quantity: 1, unitPriceMinor: 1735, netMinor: 1735, taxMinor: 347, grossMinor: 2082, taxTreatment: 'standard', taxRateBps: 2000,
  }] };
  const submission = { submission_data: { cart: { version: 1, lines: [{ kind: 'product', id: productId, quantity: 1 }] }, __cart_receipt: receipt } };
  const before = JSON.stringify(submission);
  const prepared = resolveSubmissionToPrepared({
    submission, form: { fields: [{ id: 'cart', type: 'sales_cart', label: 'Cart' }] },
    selectedOptions: [{ key: 'cart', label: 'Cart' }, { key: '__cart_receipt', label: 'Internal metadata' }], resolvers: {},
  });
  assert.equal(prepared.rows.length, 1);
  const text = prepared.rows[0].lines.map(line => line.text).join('\n');
  assert.match(text, /Original handbook — Archived edition/);
  assert.match(text, /Total: GBP 20.82/);
  assert.equal(text, formatCartReceipt(receipt));
  assert.equal(JSON.stringify(submission), before);
  for (const form of [null, { fields: [] }, { fields: [{ id: 'cart', type: 'text', label: 'Renamed and retyped' }] }]) {
    for (const selectedOptions of [[{ key: 'cart', label: 'Old cart' }], []]) {
      const historical = resolveSubmissionToPrepared({ submission, form, selectedOptions, resolvers: {} });
      assert.equal(historical.rows.length, 1);
      assert.equal(historical.rows[0].lines.map(line => line.text).join('\n'), formatCartReceipt(receipt));
    }
  }
});
