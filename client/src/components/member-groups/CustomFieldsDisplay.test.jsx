import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CustomFieldsDisplay from './CustomFieldsDisplay.jsx';
import CustomFieldInputs from './CustomFieldInputs.jsx';

test('detail output escapes names and values, retains line breaks, zero and No, and omits blanks', () => {
  const html = renderToStaticMarkup(<CustomFieldsDisplay fields={[
    { id: 'text', name: '<script>name</script>', type: 'textarea', value: '<img src=x onerror=alert(1)>\nSecond line' },
    { id: 'number', name: 'Capacity', type: 'number', value: 0 },
    { id: 'boolean', name: 'Open', type: 'boolean', value: false },
    { id: 'blank', name: 'Hidden blank', type: 'text', value: '  ' },
  ]} />);
  assert.ok(html.includes('&lt;script&gt;name&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;\nSecond line'));
  assert.ok(html.includes('>0</div>'));
  assert.ok(html.includes('>No</div>'));
  assert.ok(!html.includes('Hidden blank'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.equal(renderToStaticMarkup(<CustomFieldsDisplay />), '');
});

test('all configured fields have appropriate optional inputs, including tri-state booleans', () => {
  const fields = ['text', 'textarea', 'number', 'date', 'select', 'boolean', 'email', 'url'].map((type) => ({
    id: type, type, name: type, choices: type === 'select' ? ['North'] : [],
  }));
  const definitions = { ready: true, allowed: true, data: { fields } };
  const html = renderToStaticMarkup(<CustomFieldInputs definitions={definitions} values={{ boolean: false, number: 0 }} onChange={() => {}} />);
  for (const field of fields) assert.ok(html.includes(`group-custom-field-${field.id}`));
  for (const type of ['number', 'date', 'email', 'url']) assert.ok(html.includes(`type="${type}"`));
  assert.ok(html.includes('<textarea'));
  assert.ok(!html.includes('required='));
  assert.ok(html.includes('>No</span>'));
  const unset = renderToStaticMarkup(<CustomFieldInputs definitions={definitions} onChange={() => {}} />);
  assert.ok(unset.includes('Not set'));
});

test('failed and loading definitions never expose editable values and offer an error retry', () => {
  const error = renderToStaticMarkup(<CustomFieldInputs definitions={{ allowed: true, isError: true, refetch() {} }} values={{ secret: 'should not render' }} onChange={() => {}} />);
  assert.ok(error.includes('Retry loading fields'));
  assert.ok(error.includes('saving is unavailable'));
  assert.ok(!error.includes('should not render'));
  const loading = renderToStaticMarkup(<CustomFieldInputs definitions={{ allowed: true, ready: false }} onChange={() => {}} />);
  assert.ok(loading.includes('Loading custom fields'));
  assert.ok(!loading.includes('<input'));
});
