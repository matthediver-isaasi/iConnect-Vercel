import assert from 'node:assert/strict';
import test from 'node:test';
import { duplicateFormField } from './formFieldDuplication.js';

test('duplicates a field immediately after its source, preserving layout and external configuration', () => {
  const form = {
    fields: [
      { id: 'before', label: 'Before' },
      {
        id: 'source', label: 'Email', page_id: 'page1', column_index: 2,
        options: [{ value: 'source', label: 'source' }],
        conditional_filters: { rules: [
          { id: 'rule1', source_field_id: 'before', value: 'source' },
        ] },
        field_mappings: { 'external-field': 'before', source: 'source' },
        price_field_id: 'before',
        invoice_address_field_id: 'source',
        custom_field_id: 'source',
        relationship_definition_id: 'source',
      },
      { id: 'after', label: 'After' },
    ],
    pages: [{ id: 'page1', title: 'Page' }],
    uniqueness_checks: [
      { field_id: 'source', target_field: 'member.email', error_message: 'Already used', options: { a: 1 } },
      { field_id: 'before', target_field: 'member.name' },
    ],
    rules: [{ target_field_id: 'source' }],
    entity_pipelines: { member: { mappings: [{ source_field_id: 'source' }] } },
    field_mappings: [{ source_field_id: 'source', target_field_id: 'source' }],
    submission_emails: [{ condition: { field_id: 'source' } }],
  };
  const snapshot = JSON.stringify(form);
  const { form: result, field } = duplicateFormField(form, 'source');
  assert.equal(JSON.stringify(form), snapshot);
  assert.notEqual(result, form);
  assert.deepEqual(result.fields.map(item => item.id), ['before', 'source', field.id, 'after']);
  assert.match(field.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(field.label, 'Email (copy)');
  assert.equal(field.page_id, 'page1');
  assert.equal(field.column_index, 2);
  assert.notEqual(field.conditional_filters.rules[0].id, 'rule1');
  assert.equal(field.conditional_filters.rules[0].source_field_id, 'before');
  assert.equal(field.conditional_filters.rules[0].value, 'source');
  assert.equal(field.options[0].value, 'source');
  assert.equal(field.field_mappings.source, field.id);
  assert.equal(field.field_mappings['external-field'], 'before');
  assert.equal(field.invoice_address_field_id, field.id);
  assert.equal(field.custom_field_id, 'source');
  assert.equal(field.relationship_definition_id, 'source');
  assert.deepEqual(result.uniqueness_checks.map(check => check.field_id), ['source', 'before', field.id]);
  assert.deepEqual(result.uniqueness_checks[2].options, { a: 1 });
  for (const key of ['pages', 'rules', 'entity_pipelines', 'field_mappings', 'submission_emails']) {
    assert.deepEqual(result[key], form[key]);
  }
  field.options[0].value = 'changed';
  field.conditional_filters.rules[0].value = 'changed';
  result.uniqueness_checks[2].options.a = 2;
  assert.equal(form.fields[1].options[0].value, 'source');
  assert.equal(form.fields[1].conditional_filters.rules[0].value, 'source');
  assert.equal(form.uniqueness_checks[0].options.a, 1);
});

test('remaps same-row children and references, leaving form-level and external IDs alone', () => {
  const form = {
    fields: [{
      id: 'row', type: 'repeatable_rows', label: 'Rows', repeatable_row: {
        children: [
          { id: 'first', label: 'First' },
          {
            id: 'second', label: 'Second', parent_field_id: 'first',
            organisation_group_parent_field_id: 'first',
            parent_field_scope: 'row',
            conditional_filters: { rules: [
              { id: 'dependency_first', source_field_id: 'first', value: 'first' },
            ] },
            row_visibility: { mode: 'show_when', source_field_id: 'first', value: 'first' },
            exclude_values_from: { scope: 'form', source_field_id: 'outside' },
            option_source: {
              custom_object_id: 'first', primary_display_field_id: 'first',
              value_field_id: 'first',
              filters: [{ field_id: 'first', source_field_id: 'first' }],
            },
          },
        ],
      },
    }, { id: 'outside', label: 'Outside' }],
    uniqueness_checks: [],
  };
  const { form: result, field } = duplicateFormField(form, 'row');
  const [first, second] = field.repeatable_row.children;
  assert.notEqual(first.id, 'first');
  assert.notEqual(second.id, 'second');
  assert.notEqual(first.id, second.id);
  assert.equal(second.parent_field_id, first.id);
  assert.equal(second.organisation_group_parent_field_id, first.id);
  assert.equal(second.conditional_filters.rules[0].source_field_id, first.id);
  assert.notEqual(second.conditional_filters.rules[0].id, 'dependency_first');
  assert.equal(second.row_visibility.source_field_id, first.id);
  assert.equal(second.exclude_values_from.source_field_id, 'outside');
  assert.equal(second.option_source.filters[0].source_field_id, first.id);
  assert.equal(second.option_source.filters[0].field_id, 'first');
  assert.equal(second.option_source.custom_object_id, 'first');
  assert.equal(second.option_source.primary_display_field_id, 'first');
  assert.equal(second.option_source.value_field_id, 'first');
  second.option_source.filters[0].field_id = 'modified';
  assert.equal(form.fields[0].repeatable_row.children[1].option_source.filters[0].field_id, 'first');
  assert.equal(result.uniqueness_checks, form.uniqueness_checks);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
});

test('supports legacy child locations and rapid consecutive duplication without reusing IDs', () => {
  const original = {
    fields: [{
      id: 'root', label: 'Question', child_fields: [
        { id: 'child', conditional_filters: { rules: [{ id: 'rule', source_field_id: 'child' }] } },
      ],
    }],
  };
  let current = original;
  const ids = new Set(['root', 'child', 'rule']);
  for (let i = 0; i < 50; i++) {
    const { form, field } = duplicateFormField(current, i ? current.fields[i].id : 'root');
    const child = field.child_fields[0];
    for (const id of [field.id, child.id, child.conditional_filters.rules[0].id]) {
      assert.equal(ids.has(id), false);
      ids.add(id);
    }
    assert.equal(child.conditional_filters.rules[0].source_field_id, child.id);
    current = form;
  }
  assert.equal(current.fields.length, 51);
  assert.deepEqual(original.fields[0].child_fields[0].conditional_filters.rules[0],
    { id: 'rule', source_field_id: 'child' });
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(current)));
  assert.throws(() => duplicateFormField(current, 'missing'), /not found/);
});