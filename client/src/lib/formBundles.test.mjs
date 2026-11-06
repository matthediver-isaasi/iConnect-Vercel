import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleConfigurationError, bundlePriceSource, parseBundleStock, bundleSubmissionLabel } from './formBundles.js';
import { resolveSubmissionToPrepared } from './formSubmissionWordExport.js';

const id = '12345678-1234-4234-8234-123456789012';
const bundle = { id: 'offer', type: 'sales_bundle', allowed_bundle_ids: [id], required: true };
test('bundle configuration is single, top-level and non-survey', () => {
  assert.equal(bundleConfigurationError({ fields: [bundle] }), null);
  assert.ok(bundleConfigurationError({ fields: [bundle, { ...bundle, id: 'other' }] }));
  assert.ok(bundleConfigurationError({ form_type: 'survey', fields: [bundle] }));
  assert.ok(bundleConfigurationError({ fields: [{ type: 'repeatable_rows', children: [bundle] }] }));
  assert.ok(bundleConfigurationError({ fields: [{ type: 'grouped_question', sub_questions: [bundle] }] }));
  assert.ok(bundleConfigurationError({ fields: [{ ...bundle, allowed_bundle_ids: ['invalid'] }] }));
});
test('only a payment referencing a bundle invokes bundle pricing', () => {
  assert.equal(bundlePriceSource({ fields: [bundle] }), null);
  assert.equal(bundlePriceSource({ fields: [bundle, { type: 'payment', price_field_id: 'offer' }] }), bundle);
});
test('stock is explicitly unlimited or a safe nonnegative integer', () => {
  assert.equal(parseBundleStock(true, ''), null);
  assert.equal(parseBundleStock(false, '0'), 0);
  assert.equal(parseBundleStock(false, '27'), 27);
  for (const value of ['', '-1', '1.2', '1e3', 'Infinity', '9007199254740992']) assert.throws(() => parseBundleStock(false, value));
});
test('historical bundle labels use immutable metadata without rewriting UUID values', () => {
  const data = { offer: id, __bundle_labels: { offer: 'Delegate package — original name' } };
  assert.equal(bundleSubmissionLabel(data, bundle, id), 'Delegate package — original name');
  assert.equal(data.offer, id);
  assert.equal(bundleSubmissionLabel({}, bundle, id), id);
});
test('Word export resolves the historical bundle label and omits internal metadata', () => {
  const submission = { submission_data: { offer: id, __bundle_labels: { offer: 'Original delegate package' } } };
  const prepared = resolveSubmissionToPrepared({
    submission, form: { fields: [bundle] },
    selectedOptions: [{ key: 'offer', label: 'Bundle' }, { key: '__bundle_labels', label: 'Internal metadata' }],
    resolvers: {},
  });
  assert.equal(prepared.rows.length, 1);
  assert.match(prepared.rows[0].lines.map(line => line.text).join('\n'), /Original delegate package/);
});
