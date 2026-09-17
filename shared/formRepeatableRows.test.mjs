import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRepeatableRowId,
  ensureRepeatableRowIds,
  formatRepeatableRows,
  isRepeatableUniqueOptionAvailable,
  isRepeatableRowEmpty,
  normalizeRepeatableRowField,
  repeatableEmptyAvailabilitySupport,
  repeatableRowAddLabelEditorValue,
  supportsRepeatableRowStaticOptions,
  parseRepeatableRowOptionsText,
  repeatableRowFieldConfigUpdate,
  repeatableSiblingUniqueValueKeys,
  repeatableSiblingUniqueValues,
  repeatableRowVisibilitySources,
  repeatableRowVisibilityOptions,
  validateRepeatableRowVisibilityConfiguration,
  getRepeatableRowHiddenChildIds,
  effectiveRepeatableRowAnswers,
  isRepeatableExclusionSourceCompatible,
  repeatableExclusionSourceFields,
  repeatableSelectionContainsExcludedValue,
  removeRepeatableExcludedSelection,
  resolveRepeatableExcludedValues,
  REPEATABLE_ROW_LAYOUT_CARDS,
  REPEATABLE_ROW_LAYOUT_SPREADSHEET,
  validateRepeatableRows,
} from './formRepeatableRows.js';

const field = {
  id: 'employment',
  type: 'repeatable_row',
  repeatable_row: {
    version: 1,
    min_rows: 1,
    max_rows: 2,
    children: [
      { id: 'org', label: 'Organisation', type: 'organisation_dropdown', required: true },
      {
        id: 'department',
        label: 'Department',
        type: 'relationship_dropdown',
        required: true,
        parent_field_id: 'org',
        relationship_definition_id: 'rel-1',
        custom_object_id: 'department-object',
        custom_object_primary_display_field_id: 'name-field',
      },
      { id: 'title', label: 'Job title', type: 'text' },
    ],
  },
};

test('normalizes the versioned schema while retaining legacy top-level properties', () => {
  assert.deepEqual(normalizeRepeatableRowField(field).children.map((child) => child.id), ['org', 'department', 'title']);
  assert.equal(normalizeRepeatableRowField({
    type: 'repeatable_grid',
    minimum_rows: 2,
    maximum_rows: 4,
    child_fields: [{ id: 'name', type: 'text' }],
  }).min_rows, 2);
});

test('normalizes availability hiding off by default and supports the reported form-scoped organisation source', () => {
  const rows = {
    id: 'additional-sites',
    type: 'repeatable_rows',
    children: [{
      id: 'organisation',
      type: 'organisation_dropdown',
      organisation_group_parent_field_id: 'trust-group',
      organisation_group_parent_scope: 'form',
      exclude_values_from: { scope: 'form', source_field_id: 'primary-organisation' },
    }],
  };
  assert.equal(normalizeRepeatableRowField(rows).hide_when_first_column_empty, false);
  assert.deepEqual(repeatableEmptyAvailabilitySupport(rows), {
    supported: true,
    reason: null,
  });
  assert.equal(normalizeRepeatableRowField({
    ...rows,
    repeatable_row: { hide_when_first_column_empty: true, children: rows.children },
  }).hide_when_first_column_empty, true);
  for (const value of ['true', 1, '1', {}, []]) {
    assert.equal(normalizeRepeatableRowField({
      ...rows,
      hide_when_first_column_empty: value,
    }).hide_when_first_column_empty, false);
  }
});

test('does not claim deterministic availability for row-scoped or non-option first columns', () => {
  assert.equal(repeatableEmptyAvailabilitySupport({
    type: 'repeatable_rows',
    children: [{
      id: 'organisation',
      type: 'organisation_dropdown',
      organisation_group_parent_field_id: 'group',
    }],
  }).reason, 'row_scoped_group_dependency');
  assert.equal(repeatableEmptyAvailabilitySupport({
    type: 'repeatable_rows',
    children: [{ id: 'name', type: 'text' }],
  }).supported, false);
});

test('repeatable rows default to cards and accept only the spreadsheet layout', () => {
  assert.equal(normalizeRepeatableRowField(field).layout, REPEATABLE_ROW_LAYOUT_CARDS);
  assert.equal(normalizeRepeatableRowField({
    type: 'repeatable_rows',
    layout: 'spreadsheet',
  }).layout, REPEATABLE_ROW_LAYOUT_SPREADSHEET);
  assert.equal(normalizeRepeatableRowField({
    type: 'repeatable_rows',
    display_style: 'spreadsheet',
  }).layout, REPEATABLE_ROW_LAYOUT_SPREADSHEET);
  assert.equal(normalizeRepeatableRowField({
    type: 'repeatable_rows',
    layout: 'forged',
  }).layout, REPEATABLE_ROW_LAYOUT_CARDS);
});

test('add label preserves spaces while editing and normalizes for rendering', () => {
  const nested = {
    type: 'repeatable_rows',
    repeatable_row: { add_row_label: 'Add another attendee ' },
  };
  assert.equal(repeatableRowAddLabelEditorValue(nested), 'Add another attendee ');
  assert.equal(normalizeRepeatableRowField(nested).add_row_label, 'Add another attendee');

  const legacy = { type: 'repeatable_rows', add_row_label: 'Add a guest ' };
  assert.equal(repeatableRowAddLabelEditorValue(legacy), 'Add a guest ');
  assert.equal(normalizeRepeatableRowField(legacy).add_row_label, 'Add a guest');

  const blank = { type: 'repeatable_rows', add_row_label: '   ' };
  assert.equal(repeatableRowAddLabelEditorValue(blank), '   ');
  assert.equal(normalizeRepeatableRowField(blank).add_row_label, 'Add another');
  assert.equal(repeatableRowAddLabelEditorValue({ type: 'repeatable_rows' }), 'Add another');
});

test('static option editing covers renderer choice types without including dynamic or free-entry columns', () => {
  for (const type of ['select', 'dropdown', 'radio', 'checkbox']) {
    assert.equal(supportsRepeatableRowStaticOptions({ type }), true, type);
  }
  for (const type of ['text', 'list', 'boolean', 'date', 'country', 'countries',
    'category_dropdown', 'category_multiselect', 'custom_field',
    'organisation_dropdown', 'relationship_dropdown']) {
    assert.equal(supportsRepeatableRowStaticOptions({ type }), false, type);
  }
});

test('row visibility exposes only static single-select dropdown sources and their options', () => {
  const visibilityField = {
    type: 'repeatable_rows',
    children: [
      {
        id: 'kind',
        type: 'dropdown',
        options: [{ value: 'member', label: 'Member' }, { value: 'guest', label: 'Guest' }],
      },
      { id: 'details', type: 'text' },
      { id: 'dynamic', type: 'select', option_source: { kind: 'records' } },
      { id: 'multi', type: 'dropdown', selection_mode: 'multiple', options: ['x'] },
    ],
  };
  assert.deepEqual(
    repeatableRowVisibilitySources(visibilityField, visibilityField.children[1])
      .map(source => source.id),
    ['kind'],
  );
  assert.deepEqual(repeatableRowVisibilityOptions(visibilityField.children[0]), [
    { value: 'member', label: 'Member' },
    { value: 'guest', label: 'Guest' },
  ]);
  assert.deepEqual(repeatableRowVisibilityOptions(visibilityField.children[2]), []);
});

test('row visibility evaluates raw answers, preserves static hidden state, and projects metadata', () => {
  const visibilityField = {
    type: 'repeatable_rows',
    children: [
      {
        id: 'kind',
        type: 'select',
        options: ['member', 'guest'],
      },
      {
        id: 'member_only',
        type: 'text',
        required: true,
        row_visibility: { mode: 'show_when', source_field_id: 'kind', value: 'member' },
      },
      {
        id: 'guest_only',
        type: 'text',
        starts_hidden: true,
        row_visibility: { mode: 'show_when', source_field_id: 'kind', value: 'guest' },
      },
    ],
  };
  const rawRow = {
    kind: 'member',
    member_only: 'kept',
    guest_only: 'retained raw answer',
    __not_listed_choice_text: { member_only: 'Member', guest_only: 'Guest' },
  };
  assert.deepEqual([...getRepeatableRowHiddenChildIds(visibilityField, rawRow)], ['guest_only']);
  const projected = effectiveRepeatableRowAnswers(visibilityField, [rawRow]);
  assert.deepEqual(projected, [{
    kind: 'member',
    member_only: 'kept',
    __not_listed_choice_text: { member_only: 'Member' },
  }]);
  assert.deepEqual(rawRow.__not_listed_choice_text, {
    member_only: 'Member',
    guest_only: 'Guest',
  });
  assert.equal(validateRepeatableRows(visibilityField, [rawRow]).valid, true);
  assert.equal(validateRepeatableRows(visibilityField, [{
    kind: 'guest',
    member_only: 'invalid hidden answer',
  }]).valid, true);
});

test('legacy string hidden flags match boolean hidden flags', () => {
  const fieldWithLegacyFlags = {
    type: 'repeatable_rows',
    children: [
      { id: 'boolean_hidden', type: 'text', hidden: true },
      { id: 'string_hidden', type: 'text', hidden: 'true' },
      { id: 'string_starts_hidden', type: 'text', starts_hidden: 'true' },
      { id: 'visible', type: 'text' },
    ],
  };
  assert.deepEqual(
    [...getRepeatableRowHiddenChildIds(fieldWithLegacyFlags, { visible: 'ok' })],
    ['boolean_hidden', 'string_hidden', 'string_starts_hidden'],
  );
  assert.deepEqual(
    [...getRepeatableRowHiddenChildIds(
      { id: 'container', ...fieldWithLegacyFlags },
      { visible: 'ok' },
      { hiddenFieldIds: new Set(['container']) },
    )],
    ['boolean_hidden', 'string_hidden', 'string_starts_hidden', 'visible'],
  );
});

test('chained visibility conditions use retained raw sources after projection', () => {
  const chained = {
    type: 'repeatable_rows',
    children: [
      { id: 'gate', type: 'dropdown', options: ['off', 'on'] },
      {
        id: 'kind',
        type: 'dropdown',
        options: ['yes', 'no'],
        row_visibility: { mode: 'show_when', source_field_id: 'gate', value: 'on' },
      },
      {
        id: 'details',
        type: 'text',
        required: true,
        row_visibility: { mode: 'show_when', source_field_id: 'kind', value: 'yes' },
      },
    ],
  };
  const rawRows = [{ gate: 'off', kind: 'yes' }];
  assert.deepEqual([...getRepeatableRowHiddenChildIds(chained, rawRows[0])], ['kind']);
  assert.deepEqual(effectiveRepeatableRowAnswers(chained, rawRows), [{ gate: 'off' }]);
  const validation = validateRepeatableRows(chained, rawRows);
  assert.ok(validation.errors.some(error => (
    error.code === 'required_child' && error.child_id === 'details'
  )));
});

test('row visibility configuration rejects invalid sources and values instead of hiding them', () => {
  const fieldWithInvalidRules = {
    type: 'repeatable_rows',
    children: [
      { id: 'source', type: 'dropdown', options: ['yes'] },
      { id: 'dynamic', type: 'select', option_source: { kind: 'records' } },
      { id: 'bad_source', type: 'text', row_visibility: {
        mode: 'show_when', source_field_id: 'dynamic', value: 'x',
      } },
      { id: 'bad_value', type: 'text', row_visibility: {
        mode: 'hide_when', source_field_id: 'source', value: 'no',
      } },
      { id: 'malformed', type: 'text', row_visibility: { mode: 'later' } },
    ],
  };
  const errors = validateRepeatableRowVisibilityConfiguration(fieldWithInvalidRules);
  assert.equal(errors.length, 3);
  assert.deepEqual(new Set(errors.map(error => error.child_id)), new Set([
    'bad_source', 'bad_value', 'malformed',
  ]));
  assert.deepEqual([...getRepeatableRowHiddenChildIds(fieldWithInvalidRules, {
    source: 'yes',
  })], []);
});

test('row visibility rejects two-field and three-field cycles but allows acyclic forward references', () => {
  const cycle = (ids) => ({
    type: 'repeatable_rows',
    children: ids.map((id, index) => ({
      id,
      type: 'dropdown',
      options: ['yes'],
      row_visibility: {
        mode: 'show_when',
        source_field_id: ids[(index + 1) % ids.length],
        value: 'yes',
      },
    })),
  });
  for (const ids of [['first', 'second'], ['one', 'two', 'three']]) {
    const errors = validateRepeatableRowVisibilityConfiguration(cycle(ids));
    assert.deepEqual(
      new Set(errors.filter(error => error.code === 'invalid_row_visibility_cycle')
        .map(error => error.child_id)),
      new Set(ids),
    );
    assert.equal(
      validateRepeatableRows(cycle(ids), []).errors
        .some(error => error.code === 'invalid_row_visibility_cycle'),
      true,
    );
  }
  const forward = {
    type: 'repeatable_rows',
    children: [
      {
        id: 'details',
        type: 'text',
        row_visibility: {
          mode: 'show_when',
          source_field_id: 'kind',
          value: 'yes',
        },
      },
      { id: 'kind', type: 'dropdown', options: ['yes', 'no'] },
    ],
  };
  assert.deepEqual(validateRepeatableRowVisibilityConfiguration(forward), []);
});

test('row visibility rejects unsupported operators and scopes instead of ignoring them', () => {
  const base = {
    type: 'repeatable_rows',
    children: [
      { id: 'source', type: 'dropdown', options: ['yes'] },
      { id: 'target', type: 'text' },
    ],
  };
  for (const extra of [{ operator: 'not_equals' }, { scope: 'form' }]) {
    const fieldWithUnsupportedRule = {
      ...base,
      children: [
        base.children[0],
        {
          ...base.children[1],
          row_visibility: {
            mode: 'show_when',
            source_field_id: 'source',
            value: 'yes',
            ...extra,
          },
        },
      ],
    };
    assert.equal(validateRepeatableRowVisibilityConfiguration(fieldWithUnsupportedRule).length, 1);
  }
  assert.deepEqual(validateRepeatableRowVisibilityConfiguration({
    ...base,
    children: [
      base.children[0],
      {
        ...base.children[1],
        row_visibility: {
          mode: 'show_when',
          source_field_id: 'source',
          value: 'yes',
          operator: 'equals',
          scope: 'row',
        },
      },
    ],
  }), []);
});

test('referenced visibility sources must be scalar while unreferenced legacy choices retain array behavior', () => {
  const conditional = {
    type: 'repeatable_rows',
    children: [
      { id: 'source', type: 'dropdown', options: ['Yes'] },
      {
        id: 'details',
        type: 'text',
        required: true,
        row_visibility: { mode: 'show_when', source_field_id: 'source', value: 'Yes' },
      },
    ],
  };
  const forged = validateRepeatableRows(conditional, [{
    source: ['Yes'],
    details: 'present',
  }]);
  assert.equal(forged.valid, false);
  assert.ok(forged.errors.some(error => (
    error.code === 'invalid_selection' && error.child_id === 'source'
  )));

  const scalarTypes = {
    type: 'repeatable_rows',
    children: [
      { id: 'number_source', type: 'dropdown', options: [1] },
      { id: 'boolean_source', type: 'select', options: [true] },
      {
        id: 'details',
        type: 'text',
        row_visibility: { mode: 'show_when', source_field_id: 'number_source', value: 1 },
      },
    ],
  };
  assert.equal(validateRepeatableRows(scalarTypes, [{
    number_source: 1,
    boolean_source: true,
    details: 'present',
  }]).valid, true);

  assert.equal(validateRepeatableRows({
    type: 'repeatable_rows',
    children: [{ id: 'legacy', type: 'dropdown', options: ['Yes'] }],
  }, [{ legacy: ['Yes'] }]).valid, true);
});

test('hidden children are excluded from required, options, date, and uniqueness checks', () => {
  const fieldWithHiddenChildren = {
    type: 'repeatable_rows',
    children: [
      { id: 'kind', type: 'dropdown', options: ['show', 'hide'] },
      {
        id: 'required_value',
        type: 'text',
        required: true,
        row_visibility: { mode: 'show_when', source_field_id: 'kind', value: 'show' },
      },
      {
        id: 'choice',
        type: 'dropdown',
        options: ['allowed'],
        unique_across_rows: true,
        row_visibility: { mode: 'show_when', source_field_id: 'kind', value: 'show' },
      },
      {
        id: 'date',
        type: 'date',
        date_restriction: 'future',
        row_visibility: { mode: 'show_when', source_field_id: 'kind', value: 'show' },
      },
    ],
  };
  const result = validateRepeatableRows(fieldWithHiddenChildren, [
    { kind: 'hide', required_value: '', choice: 'forged', date: '2000-01-01' },
    { kind: 'hide', required_value: '', choice: 'forged', date: '2000-01-01' },
  ], { now: new Date('2026-01-01T00:00:00Z') });
  assert.equal(result.valid, true);
});

test('option text commits trimmed non-empty choices for typed, pasted, and cleared input', () => {
  assert.deepEqual(parseRepeatableRowOptionsText(' First choice \n\n Second choice \n  \n'), [
    'First choice', 'Second choice',
  ]);
  assert.deepEqual(parseRepeatableRowOptionsText('One\r\n Two \rThree\n'), ['One', 'Two', 'Three']);
  assert.deepEqual(parseRepeatableRowOptionsText(' \n\t\n'), []);
  assert.deepEqual(parseRepeatableRowOptionsText(''), []);
  assert.deepEqual(parseRepeatableRowOptionsText('0\nTwo words\nA & B'), ['0', 'Two words', 'A & B']);
});

test('repeatable child uniqueness is opt-in and normalized strictly', () => {
  const config = normalizeRepeatableRowField({
    type: 'repeatable_rows',
    child_fields: [
      { id: 'enabled', type: 'text', unique_across_rows: true },
      { id: 'disabled', type: 'text', unique_across_rows: 'true' },
      { id: 'missing', type: 'text' },
    ],
  });
  assert.deepEqual(
    config.children.map(child => child.unique_across_rows),
    [true, false, false],
  );
});

test('normalizes explicit form-scoped exclusion sources and drops malformed legacy data', () => {
  const configured = normalizeRepeatableRowField({
    type: 'repeatable_rows',
    children: [{
      id: 'org',
      type: 'organisation_dropdown',
      exclude_values_from: { scope: 'form', source_field_id: 'primary_org', forged: true },
    }],
  });
  assert.deepEqual(configured.children[0].exclude_values_from, {
    scope: 'form',
    source_field_id: 'primary_org',
  });
  assert.equal(normalizeRepeatableRowField({
    type: 'repeatable_rows',
    children: [{
      id: 'org',
      type: 'organisation_dropdown',
      exclude_values_from: { scope: 'row', source_field_id: 'primary_org' },
    }],
  }).children[0].exclude_values_from, undefined);
});

test('offers only compatible top-level exclusion sources before the repeatable container', () => {
  const rows = {
    id: 'rows',
    type: 'repeatable_rows',
    children: [{
      id: 'department',
      type: 'relationship_dropdown',
      related_kind: 'custom_object',
      related_custom_object_id: 'department-object',
    }],
  };
  const fields = [
    { id: 'primary_org', type: 'organisation_dropdown' },
    {
      id: 'primary_department',
      type: 'relationship_dropdown',
      related_kind: 'custom_object',
      related_custom_object_id: 'department-object',
    },
    {
      id: 'other_relationship',
      type: 'relationship_dropdown',
      related_kind: 'custom_object',
      related_custom_object_id: 'team-object',
    },
    rows,
    {
      id: 'later_department',
      type: 'relationship_dropdown',
      related_kind: 'custom_object',
      related_custom_object_id: 'department-object',
    },
  ];
  assert.equal(isRepeatableExclusionSourceCompatible(rows.children[0], fields[1]), true);
  assert.equal(isRepeatableExclusionSourceCompatible(rows.children[0], fields[0]), false);
  assert.deepEqual(
    repeatableExclusionSourceFields(fields, rows, rows.children[0]).map(source => source.id),
    ['primary_department'],
  );
});

test('resolves scalar and multi-value root exclusions and leaves empty answers unrestricted', () => {
  const child = {
    id: 'choice',
    type: 'select',
    exclude_values_from: { scope: 'form', source_field_id: 'primary' },
  };
  const rows = { id: 'rows', type: 'repeatable_rows', children: [child] };
  const fields = [{ id: 'primary', name: 'primary_choice', type: 'checkbox' }, rows];
  assert.deepEqual(resolveRepeatableExcludedValues(child, fields, {
    primary_choice: ['A', { value: 'B' }, ''],
  }, rows), ['A', 'B']);
  assert.equal(repeatableSelectionContainsExcludedValue('A', child, ['A', 'B']), true);
  assert.equal(repeatableSelectionContainsExcludedValue(['C', 'B'], child, ['A', 'B']), true);
  assert.equal(repeatableSelectionContainsExcludedValue('C', child, ['A', 'B']), false);
  assert.equal(removeRepeatableExcludedSelection('A', child, ['A', 'B']), '');
  assert.deepEqual(removeRepeatableExcludedSelection(['A', 'C', 'B'], child, ['A', 'B']), ['C']);
  const unchanged = ['C'];
  assert.strictEqual(removeRepeatableExcludedSelection(unchanged, child, ['A', 'B']), unchanged);
  assert.deepEqual(resolveRepeatableExcludedValues(child, fields, { primary: [] }, rows), []);
});

test('rejects missing, later, incompatible, and malformed exclusion sources', () => {
  const makeRows = exclude_values_from => ({
    id: 'rows',
    type: 'repeatable_rows',
    children: [{
      id: 'org',
      type: 'organisation_dropdown',
      exclude_values_from,
    }],
  });
  const validRows = makeRows({ scope: 'form', source_field_id: 'primary_org' });
  assert.equal(validateRepeatableRows(validRows, [], {
    rootFields: [{ id: 'primary_org', type: 'organisation_dropdown' }, validRows],
  }).valid, true);
  for (const [config, rootFields] of [
    [{ scope: 'form', source_field_id: 'missing' }, [{ id: 'primary_org', type: 'organisation_dropdown' }]],
    [{ scope: 'form', source_field_id: 'later' }, []],
    [{ scope: 'form', source_field_id: 'primary_text' }, [{ id: 'primary_text', type: 'text' }]],
    [{ scope: 'row', source_field_id: 'primary_org' }, [{ id: 'primary_org', type: 'organisation_dropdown' }]],
  ]) {
    const rows = makeRows(config);
    const fields = [...rootFields, rows, ...(config.source_field_id === 'later'
      ? [{ id: 'later', type: 'organisation_dropdown' }] : [])];
    assert.ok(validateRepeatableRows(rows, [], { rootFields: fields }).errors
      .some(error => error.code === 'invalid_exclusion_source'));
  }
});

test('repeatable config updates preserve the active top-level or nested storage shape', () => {
  assert.deepEqual(repeatableRowFieldConfigUpdate({
    type: 'repeatable_rows',
    child_fields: [{ id: 'old' }],
  }, {
    layout: 'spreadsheet',
    children: [{ id: 'new' }],
  }), {
    layout: 'spreadsheet',
    child_fields: [{ id: 'new' }],
  });
  assert.deepEqual(repeatableRowFieldConfigUpdate({
    type: 'repeatable_grid',
    repeatable_row: {
      version: 1,
      layout: 'cards',
      children: [{ id: 'old' }],
    },
  }, {
    layout: 'spreadsheet',
    children: [{ id: 'new' }],
  }), {
    repeatable_row: {
      version: 1,
      layout: 'spreadsheet',
      children: [{ id: 'new' }],
    },
  });
});

test('repeatable child updates preserve every supported legacy top-level child key', () => {
  for (const childKey of ['children', 'child_fields', 'fields']) {
    const fieldWithLegacyChildren = {
      type: childKey === 'fields' ? 'repeatable_grid' : 'repeatable_rows',
      [childKey]: [{ id: 'old', type: 'text' }],
    };
    const update = repeatableRowFieldConfigUpdate(fieldWithLegacyChildren, {
      children: [{ id: 'new', type: 'text' }],
    });
    const saved = { ...fieldWithLegacyChildren, ...update };
    assert.deepEqual(normalizeRepeatableRowField(saved).children.map(child => child.id), ['new']);
    assert.deepEqual(update[childKey].map(child => child.id), ['new']);
  }
});

test('stable row IDs are retained and duplicate or absent IDs are replaced', () => {
  let next = 0;
  const rows = ensureRepeatableRowIds([
    { _row_id: 'stable', title: 'One' },
    { _row_id: 'stable', title: 'Two' },
    { title: 'Three' },
  ], () => `generated-${++next}`);
  assert.deepEqual(rows.map((row) => row._row_id), ['stable', 'generated-1', 'generated-2']);
  assert.match(createRepeatableRowId(() => 0.5, () => 1), /^row_1_/);
});

test('validates bounds, required children, duplicate IDs and tampered keys', () => {
  const valid = validateRepeatableRows(field, [
    { _row_id: 'one', org: 'org-1', department: 'department-1', title: '' },
  ]);
  assert.equal(valid.valid, true);
  const invalid = validateRepeatableRows(field, [
    { _row_id: 'same', org: 'org-1', forged: 'yes' },
    { _row_id: 'same', org: 'org-2', department: 'department-2' },
    { org: 'org-3', department: 'department-3' },
  ]);
  assert.deepEqual(new Set(invalid.errors.map((error) => error.code)),
    new Set(['max_rows', 'unknown_child', 'required_child', 'invalid_row_id']));
});

test('validates repeatable date settings without checking the current clock', () => {
  const invalidConfiguration = validateRepeatableRows({
    type: 'repeatable_rows',
    child_fields: [{
      id: 'date',
      type: 'date',
      date_precision: 'week',
      date_restriction: 'future',
    }],
  }, [{ date: '2024-01-01' }]);
  assert.equal(invalidConfiguration.valid, false);
  assert.ok(invalidConfiguration.errors.some(error => (
    error.code === 'invalid_date_configuration'
  )));

  const validHistoricalShape = validateRepeatableRows({
    type: 'repeatable_rows',
    child_fields: [{
      id: 'date',
      type: 'date',
      date_precision: 'year',
      date_restriction: 'future',
    }],
  }, [{ date: '0001' }]);
  assert.equal(validHistoricalShape.errors.some(error => (
    error.code === 'invalid_date_configuration'
  )), false);
});

test('optional untouched rows are empty and do not trigger required-child errors', () => {
  const optional = {
    ...field,
    repeatable_row: { ...field.repeatable_row, min_rows: 0 },
  };
  assert.equal(isRepeatableRowEmpty({ _row_id: 'row-1' }, optional), true);
  assert.equal(validateRepeatableRows(optional, [{ _row_id: 'row-1' }]).valid, true);
});

test('unique repeatable columns reject populated duplicates and identify every conflicting row', () => {
  const uniqueField = {
    type: 'repeatable_rows',
    child_fields: [
      { id: 'org', type: 'organisation_dropdown', label: 'Organisation', unique_across_rows: true },
      { id: 'note', type: 'text' },
    ],
  };
  const result = validateRepeatableRows(uniqueField, [
    { _row_id: 'one', org: 'org-1' },
    { _row_id: 'two', org: 'org-2' },
    { _row_id: 'three', org: 'org-1' },
  ]);
  const duplicateErrors = result.errors.filter(error => error.code === 'duplicate_child_value');
  assert.equal(result.valid, false);
  assert.deepEqual(duplicateErrors.map(error => error.row), [0, 2]);
  assert.deepEqual(duplicateErrors[0].conflicting_rows, [1, 3]);
  assert.match(duplicateErrors[0].message, /Organisation must be unique; rows 1, 3/);
});

test('unique repeatable columns ignore empty values and normalize supported cell values', () => {
  const uniqueField = {
    type: 'repeatable_rows',
    child_fields: [
      { id: 'email', type: 'email', unique_across_rows: true },
      { id: 'choices', type: 'checkbox', unique_across_rows: true },
      { id: 'number', type: 'number', unique_across_rows: true },
    ],
  };
  const result = validateRepeatableRows(uniqueField, [
    { email: '', choices: [], number: '' },
    { email: ' Person@Example.com ', choices: ['B', 'A'], number: '01' },
    { email: 'person@example.com', choices: ['A', 'B'], number: 1 },
  ]);
  assert.equal(result.errors.filter(error => error.code === 'duplicate_child_value').length, 6);
  assert.equal(result.errors.some(error => error.row === 0), false);
});

test('columns without the uniqueness flag still allow repeated values', () => {
  const ordinaryField = {
    type: 'repeatable_rows',
    child_fields: [{ id: 'org', type: 'organisation_dropdown' }],
  };
  assert.equal(validateRepeatableRows(ordinaryField, [
    { org: 'org-1' },
    { org: 'org-1' },
  ]).valid, true);
});

test('unique multi-select relationship columns reject overlapping records across rows', () => {
  const field = {
    type: 'repeatable_rows',
    child_fields: [{
      id: 'department',
      type: 'relationship_dropdown',
      selection_mode: 'multiple',
      unique_across_rows: true,
    }],
  };
  const result = validateRepeatableRows(field, [
    { department: ['department-1', 'department-2'] },
    { department: ['department-2', 'department-3'] },
  ]);
  assert.deepEqual(
    result.errors.filter(error => error.code === 'duplicate_child_value').map(error => error.row),
    [0, 1],
  );
});

test('custom object row sources accept exactly one catalogue value', () => {
  const sourceChild = {
    id: 'child_record',
    type: 'relationship_dropdown',
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: '10000000-0000-0000-0000-000000000001',
      primary_display_field_id: '10000000-0000-0000-0000-000000000002',
      filters: [],
    },
  };
  const sourceField = {
    type: 'repeatable_rows',
    child_fields: [sourceChild],
  };
  assert.equal(validateRepeatableRows(sourceField, [{ child_record: 'record-1' }]).valid, true);
  for (const value of [['record-1'], '__form_not_listed__']) {
    const result = validateRepeatableRows(sourceField, [{ child_record: value }]);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.code === 'invalid_selection'));
  }
});

test('unique dropdown options exclude sibling selections but retain the current row value', () => {
  const child = {
    id: 'org',
    type: 'organisation_dropdown',
    unique_across_rows: true,
  };
  const rows = [
    { _row_id: 'one', org: 'org-1' },
    { _row_id: 'two', org: 'org-2' },
    { _row_id: 'three', org: '' },
  ];
  const excludedForSecond = repeatableSiblingUniqueValueKeys(rows, child, 'two');
  assert.equal(isRepeatableUniqueOptionAvailable('org-1', 'org-2', child, excludedForSecond), false);
  assert.equal(isRepeatableUniqueOptionAvailable('org-2', 'org-2', child, excludedForSecond), true);
  assert.equal(isRepeatableUniqueOptionAvailable('org-3', 'org-2', child, excludedForSecond), true);
  assert.equal(isRepeatableUniqueOptionAvailable('org-1', 'org-1', child, excludedForSecond), true);

  const releasedRows = rows.filter(row => row._row_id !== 'one');
  const released = repeatableSiblingUniqueValueKeys(releasedRows, child, 'two');
  assert.equal(isRepeatableUniqueOptionAvailable('org-1', 'org-2', child, released), true);
});

test('non-unique columns do not exclude sibling values', () => {
  const child = { id: 'org', type: 'organisation_dropdown' };
  const excluded = repeatableSiblingUniqueValueKeys([
    { _row_id: 'one', org: 'org-1' },
    { _row_id: 'two', org: 'org-2' },
  ], child, 'two');
  assert.equal(excluded.size, 0);
  assert.equal(isRepeatableUniqueOptionAvailable('org-1', 'org-2', child, excluded), true);
});

test('country uniqueness treats legacy codes and selectable names as the same value', () => {
  const child = { id: 'country', type: 'country', unique_across_rows: true };
  const rows = [
    { _row_id: 'one', country: 'GB' },
    { _row_id: 'two', country: '' },
  ];
  const excluded = repeatableSiblingUniqueValueKeys(rows, child, 'two');
  assert.equal(isRepeatableUniqueOptionAvailable('United Kingdom', '', child, excluded), false);
  assert.equal(validateRepeatableRows({
    type: 'repeatable_rows',
    child_fields: [child],
  }, [
    { country: 'GB' },
    { country: 'United Kingdom' },
  ]).valid, false);

  assert.deepEqual(repeatableSiblingUniqueValues(rows, child, 'two'), ['GB']);
});

test('multi-country choices only block a toggle that would duplicate the whole sibling cell', () => {
  const child = { id: 'countries', type: 'countries', unique_across_rows: true };
  const siblingRows = [
    { _row_id: 'one', countries: ['GB', 'France'] },
    { _row_id: 'two', countries: ['United Kingdom'] },
  ];
  const excluded = repeatableSiblingUniqueValueKeys(siblingRows, child, 'two');

  assert.equal(
    isRepeatableUniqueOptionAvailable(
      ['United Kingdom', 'France'],
      ['United Kingdom'],
      child,
      excluded,
    ),
    false,
  );
  assert.equal(
    isRepeatableUniqueOptionAvailable(
      ['United Kingdom', 'Germany'],
      ['United Kingdom'],
      child,
      excluded,
    ),
    true,
  );
  assert.equal(
    isRepeatableUniqueOptionAvailable(
      ['United Kingdom'],
      ['United Kingdom'],
      child,
      excluded,
    ),
    true,
  );
  assert.equal(validateRepeatableRows({
    type: 'repeatable_rows',
    child_fields: [child],
  }, [
    { countries: ['GB', 'France'] },
    { countries: ['United Kingdom', 'France'] },
  ]).valid, false);
});

test('legacy custom country values use the same code/name canonicalization', () => {
  const single = { id: 'custom_country', type: 'custom_field', unique_across_rows: true };
  assert.equal(validateRepeatableRows({
    type: 'repeatable_rows',
    child_fields: [single],
  }, [
    { custom_country: 'GB' },
    { custom_country: 'United Kingdom' },
  ]).valid, false);

  const multiple = { id: 'custom_countries', type: 'custom_field', unique_across_rows: true };
  assert.equal(validateRepeatableRows({
    type: 'repeatable_rows',
    child_fields: [multiple],
  }, [
    { custom_countries: ['GB', 'France'] },
    { custom_countries: ['United Kingdom', 'France'] },
  ]).valid, false);
});

test('rejects unsupported children, invalid dependency direction and static selections', () => {
  const unsupported = {
    type: 'repeatable_row',
    children: [
      { id: 'nested', type: 'repeatable_row' },
      { id: 'choice', type: 'dropdown', options: ['A'], dependency: { source_field_id: 'later' } },
      { id: 'later', type: 'text' },
    ],
  };
  const result = validateRepeatableRows(unsupported, [{ choice: 'forged' }]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'unsupported_child_type'));
  assert.ok(result.errors.some((error) => error.code === 'invalid_dependency'));
  assert.ok(result.errors.some((error) => error.code === 'invalid_selection'));
});

test('accepts a row-local Organisation Group to Organisation dependency and rejects invalid order', () => {
  const valid = {
    type: 'repeatable_rows',
    child_fields: [
      { id: 'group', type: 'organisation_group_dropdown' },
      { id: 'org', type: 'organisation_dropdown', organisation_group_parent_field_id: 'group' },
    ],
  };
  assert.equal(validateRepeatableRows(valid, [{ group: 'group-1', org: 'org-1' }]).valid, true);
  const invalid = {
    type: 'repeatable_rows',
    child_fields: [
      { id: 'org', type: 'organisation_dropdown', organisation_group_parent_field_id: 'group' },
      { id: 'group', type: 'organisation_group_dropdown' },
    ],
  };
  assert.ok(validateRepeatableRows(invalid, [{ group: 'group-1', org: 'org-1' }]).errors
    .some(error => error.code === 'invalid_dependency'));
});

test('supports a preceding form-scoped Organisation Group shared by every row', () => {
  const rows = {
    id: 'employment',
    type: 'repeatable_rows',
    child_fields: [{
      id: 'org',
      type: 'organisation_dropdown',
      organisation_group_parent_field_id: 'group',
      organisation_group_parent_scope: 'form',
    }],
  };
  const rootFields = [
    { id: 'group', type: 'organisation_group_dropdown' },
    rows,
  ];
  assert.equal(validateRepeatableRows(rows, [{ org: 'org-1' }, { org: 'org-2' }], {
    rootFields,
  }).valid, true);
});

test('supports a preceding form-scoped relationship organisation parent', () => {
  const rows = {
    id: 'employment',
    type: 'repeatable_rows',
    child_fields: [{
      id: 'department',
      type: 'relationship_dropdown',
      parent_field_id: 'organisation',
      parent_field_scope: 'form',
    }],
  };
  assert.equal(validateRepeatableRows(rows, [{ department: 'department-1' }], {
    rootFields: [
      { id: 'organisation', type: 'organisation_dropdown' },
      rows,
    ],
  }).valid, true);
});

test('supports row and form scoped custom-object relationship chaining', () => {
  const rowChain = {
    id: 'rows',
    type: 'repeatable_rows',
    child_fields: [
      { id: 'org', type: 'organisation_dropdown' },
      {
        id: 'account', type: 'relationship_dropdown', parent_field_id: 'org',
        related_kind: 'custom_object', related_custom_object_id: 'account-object',
      },
      {
        id: 'contact', type: 'relationship_dropdown', parent_field_id: 'account',
        relationship_parent_kind: 'custom_object',
        relationship_parent_custom_object_id: 'account-object',
      },
    ],
  };
  assert.equal(validateRepeatableRows(rowChain, [{ account: 'account-1', contact: 'contact-1' }]).valid, true);

  const formChain = {
    id: 'rows',
    type: 'repeatable_rows',
    child_fields: [{
      id: 'contact', type: 'relationship_dropdown', parent_field_id: 'account',
      parent_field_scope: 'form', relationship_parent_kind: 'custom_object',
      relationship_parent_custom_object_id: 'account-object',
    }],
  };
  assert.equal(validateRepeatableRows(formChain, [{ contact: 'contact-1' }], {
    rootFields: [
      { id: 'account', type: 'relationship_dropdown', related_custom_object_id: 'account-object' },
      formChain,
    ],
  }).valid, true);
});

test('rejects a relationship parent whose persisted descriptor does not match', () => {
  const rows = {
    type: 'repeatable_rows',
    child_fields: [
      { id: 'org', type: 'organisation_dropdown' },
      {
        id: 'account', type: 'relationship_dropdown', parent_field_id: 'org',
        related_custom_object_id: 'account-object',
      },
      {
        id: 'contact', type: 'relationship_dropdown', parent_field_id: 'account',
        relationship_parent_kind: 'custom_object',
        relationship_parent_custom_object_id: 'forged-object',
      },
    ],
  };
  assert.ok(validateRepeatableRows(rows, [{ account: 'account-1', contact: 'contact-1' }]).errors
    .some(error => error.code === 'invalid_dependency'));
});

test('rejects missing, later, and malformed form parent scopes', () => {
  const rows = {
    id: 'employment',
    type: 'repeatable_rows',
    child_fields: [{
      id: 'related',
      type: 'relationship_dropdown',
      parent_field_id: 'org',
      parent_field_scope: 'form',
    }, {
      id: 'org', type: 'organisation_dropdown',
    }],
  };
  assert.ok(validateRepeatableRows(rows, [{ related: 'record-1' }], {
    rootFields: [rows, { id: 'org', type: 'organisation_dropdown' }],
  }).errors.some(error => error.code === 'invalid_dependency'));
  assert.ok(validateRepeatableRows({
    ...rows,
    child_fields: [{ ...rows.child_fields[0], parent_field_scope: 'forged' }],
  }, [{ related: 'record-1' }], {
    rootFields: [{ id: 'org', type: 'organisation_dropdown' }, rows],
  }).errors.some(error => error.code === 'invalid_dependency'));
});

test('formats non-empty rows readably in child order', () => {
  assert.equal(formatRepeatableRows(field, [
    { org: 'Acme', department: 'Finance', title: 'Manager' },
    { org: 'Beta', department: 'Research' },
  ]), 'Row 1: Organisation: Acme; Department: Finance; Job title: Manager\n'
    + 'Row 2: Organisation: Beta; Department: Research');
});

test('URL children use the renderer-compatible optional-scheme URL pattern', () => {
  const urlField = {
    type: 'repeatable_rows',
    child_fields: [{ id: 'website', type: 'url', required: true }],
  };
  assert.equal(validateRepeatableRows(urlField, [{ website: 'example.com/path' }]).valid, true);
  assert.equal(validateRepeatableRows(urlField, [{ website: 'https://example.com' }]).valid, true);
  assert.equal(validateRepeatableRows(urlField, [{ website: 'ftp://example.com' }]).valid, false);
});