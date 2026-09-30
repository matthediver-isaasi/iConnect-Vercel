import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = readFileSync(new URL('../pages/MembershipTierManagement.jsx', import.meta.url), 'utf8');
const pricing = source.slice(source.indexOf('const renderStep5'), source.indexOf('const renderSummarySection'));
const heading = pricing.indexOf('>Invoice Address</h3>');
assert.ok(heading > 0, 'Invoice Address remains in Pricing');
const start = pricing.lastIndexOf('<div className="border-t pt-4 mt-2 space-y-4">', heading);
const end = pricing.indexOf('<div className="space-y-2 pt-4 border-t">', heading);
assert.ok(start >= 0 && end > start);
const section = pricing.slice(start, end).trim();

// Render the actual page section without loading page queries or any live services.
// Select doubles expose options and callbacks, including Radix's closed-menu content.
const { outputText } = ts.transpileModule(`return (${section});`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
});
const fragment = ({ children }) => React.createElement(React.Fragment, null, children);
const Select = ({ value, disabled, children }) => React.createElement(
  'div', { 'data-value': value, 'data-disabled': String(disabled) }, children,
);
const buildSection = new Function(
  'React', 'config', 'isEditable', 'invoiceAddressFields', 'handleConfigChange',
  'Label', 'Select', 'SelectTrigger', 'SelectValue', 'SelectContent', 'SelectItem',
  outputText,
);
const fields = [
  { id: 'core:invoicing_address', name: 'invoicing_address', label: 'Invoicing Address', is_core: true },
  { id: 'custom-address', name: 'postal_address', label: 'Postal address' },
];
function renderSection(config, editable, onChange = () => {}) {
  return buildSection(
    React, config, editable, fields, onChange,
    fragment, Select, fragment, () => null, fragment, fragment,
  );
}
function findSelect(element) {
  if (!React.isValidElement(element)) return null;
  if (element.type === Select) return element;
  return React.Children.toArray(element.props.children).map(findSelect).find(Boolean);
}

for (const scope of ['member', 'organization']) {
  for (const editable of [true, false]) {
    test(`Invoice Address guidance renders for ${scope}, editable=${editable}, without a provider connection`, () => {
      const tree = renderSection({ structure_scope_type: scope }, editable);
      const html = renderToStaticMarkup(tree);
      assert.match(html, /connected accounting system \(Xero or QuickBooks\)/);
      assert.match(html, /when this structure’s address settings apply/);
      assert.match(html, /through a form using Stripe, the invoice uses the billing address collected by Stripe, not this field/);
      assert.match(html, /leave this selector at its default if you only use that payment route/);
      assert.match(html, /To also save Stripe address details to the Member or Organisation record/);
      assert.match(html, /“Stripe billing address mappings” in the form’s payment field settings, save the mappings, then save the form/);
      assert.match(html, /non-Stripe payment routes, select the appropriate address field here/);
      assert.doesNotMatch(html, /generating Xero invoices/);
      assert.ok(html.includes(scope === 'member' ? 'None (no address)' : 'Default (Organisation Invoicing Address)'));
      assert.match(html, /Invoicing Address/);
      assert.match(html, /Postal address/);
      const select = findSelect(tree);
      assert.equal(select.props.value, '__default');
      assert.equal(select.props.disabled, !editable);
    });
  }
  test(`${scope} selection preserves core/custom values and clears the default to null`, () => {
    for (const value of ['core:invoicing_address', 'custom-address', null]) {
      const changes = [];
      const select = findSelect(renderSection(
        { structure_scope_type: scope, invoice_address_field: value },
        true,
        (...args) => changes.push(args),
      ));
      assert.equal(select.props.value, value || '__default');
      select.props.onValueChange('custom-address');
      select.props.onValueChange('core:invoicing_address');
      select.props.onValueChange('__default');
      assert.deepEqual(changes, [
        ['invoice_address_field', 'custom-address'],
        ['invoice_address_field', 'core:invoicing_address'],
        ['invoice_address_field', null],
      ]);
    }
  });
}

test('persisted address selections still hydrate from core or custom fields', () => {
  assert.match(source, /invoice_address_field: c\.invoice_address_field_id \|\| \(c\.invoice_address_field_name \? `core:\$\{c\.invoice_address_field_name\}` : null\)/);
  assert.match(source, /setConfig\(prev => \(\{ \.\.\.prev, \[key\]: value \}\)\)/);
  assert.match(source, /body: JSON\.stringify\(payload\)/);
});