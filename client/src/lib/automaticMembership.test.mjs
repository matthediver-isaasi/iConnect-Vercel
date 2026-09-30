// Run: node --test client/src/lib/automaticMembership.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  operatorsForDataType,
  isNullaryOperator,
  isMultiValueOperator,
  normalizeConditionValue,
  buildFieldOptions,
  blankFilterGroup,
  blankCondition,
  validateAutoConfig,
} from './automaticMembership.js';

// ── operatorsForDataType ──────────────────────────────────────────────────────

test('operatorsForDataType: canonical text operators', () => {
  const vals = operatorsForDataType('text').map((o) => o.value);
  assert.ok(vals.includes('contains'));
  assert.ok(vals.includes('equals'));
  assert.ok(vals.includes('not_equals'));
  assert.ok(vals.includes('is_empty'));
  assert.ok(vals.includes('is_not_empty'));
  // must NOT contain old invented codes
  assert.ok(!vals.includes('eq'), 'eq must not be present');
  assert.ok(!vals.includes('neq'), 'neq must not be present');
  assert.ok(!vals.includes('not_contains'), 'not_contains must not be present');
});

test('operatorsForDataType: canonical boolean operators — no value input needed', () => {
  const vals = operatorsForDataType('boolean').map((o) => o.value);
  assert.deepEqual(vals, ['is_true', 'is_false', 'is_empty', 'is_not_empty']);
});

test('operatorsForDataType: canonical number operators', () => {
  const vals = operatorsForDataType('number').map((o) => o.value);
  assert.ok(vals.includes('greater_than'));
  assert.ok(vals.includes('less_than'));
  assert.ok(vals.includes('equals'));
  assert.ok(vals.includes('not_equals'));
  // must NOT contain old invented codes
  assert.ok(!vals.includes('gt'), 'gt must not be present');
  assert.ok(!vals.includes('lt'), 'lt must not be present');
  assert.ok(!vals.includes('gte'), 'gte must not be present');
  assert.ok(!vals.includes('lte'), 'lte must not be present');
});

test('operatorsForDataType: canonical date operators', () => {
  const vals = operatorsForDataType('date').map((o) => o.value);
  assert.ok(vals.includes('before'));
  assert.ok(vals.includes('after'));
  assert.ok(vals.includes('equals'));
  assert.ok(!vals.includes('gt'), 'gt must not be present');
  assert.ok(!vals.includes('lt'), 'lt must not be present');
});

test('operatorsForDataType: canonical select operators', () => {
  const vals = operatorsForDataType('select').map((o) => o.value);
  assert.ok(vals.includes('equals'));
  assert.ok(vals.includes('is_one_of'));
  assert.ok(vals.includes('is_not_one_of'));
  assert.ok(!vals.includes('any_of'), 'any_of must not be present');
  assert.ok(!vals.includes('none_of'), 'none_of must not be present');
});

test('operatorsForDataType: multi_select uses containment operators', () => {
  assert.deepEqual(operatorsForDataType('multi_select').map((o) => o.value), [
    'is_one_of', 'is_not_one_of', 'is_empty', 'is_not_empty',
  ]);
});

test('operatorsForDataType: decimal uses number operators', () => {
  assert.deepEqual(
    operatorsForDataType('decimal').map((o) => o.value),
    operatorsForDataType('number').map((o) => o.value),
  );
});

test('operatorsForDataType: unknown type falls back to text operators', () => {
  const vals = operatorsForDataType('unknown_xyz').map((o) => o.value);
  assert.ok(vals.includes('contains'));
});

// ── isNullaryOperator ─────────────────────────────────────────────────────────

test('isNullaryOperator: true for is_empty / is_not_empty', () => {
  assert.equal(isNullaryOperator('is_empty'), true);
  assert.equal(isNullaryOperator('is_not_empty'), true);
});

test('isNullaryOperator: true for boolean is_true / is_false', () => {
  assert.equal(isNullaryOperator('is_true'), true);
  assert.equal(isNullaryOperator('is_false'), true);
});

test('isNullaryOperator: false for value-bearing operators', () => {
  assert.equal(isNullaryOperator('equals'), false);
  assert.equal(isNullaryOperator('contains'), false);
  assert.equal(isNullaryOperator('greater_than'), false);
});

// ── isMultiValueOperator ──────────────────────────────────────────────────────

test('isMultiValueOperator: true for is_one_of / is_not_one_of', () => {
  assert.equal(isMultiValueOperator('is_one_of'), true);
  assert.equal(isMultiValueOperator('is_not_one_of'), true);
});

test('isMultiValueOperator: false for single-value operators', () => {
  assert.equal(isMultiValueOperator('equals'), false);
  assert.equal(isMultiValueOperator('contains'), false);
  assert.equal(isMultiValueOperator('is_empty'), false);
});

// ── normalizeConditionValue ───────────────────────────────────────────────────

test('normalizeConditionValue: undefined for nullary operators', () => {
  assert.equal(normalizeConditionValue('is_empty', 'anything'), undefined);
  assert.equal(normalizeConditionValue('is_not_empty', 'anything'), undefined);
  assert.equal(normalizeConditionValue('is_true', 'yes'), undefined);
  assert.equal(normalizeConditionValue('is_false', 'no'), undefined);
});

test('normalizeConditionValue: wraps scalar in array for is_one_of', () => {
  assert.deepEqual(normalizeConditionValue('is_one_of', 'foo'), ['foo']);
});

test('normalizeConditionValue: wraps scalar in array for is_not_one_of', () => {
  assert.deepEqual(normalizeConditionValue('is_not_one_of', 'bar'), ['bar']);
});

test('normalizeConditionValue: keeps existing array for is_one_of', () => {
  assert.deepEqual(normalizeConditionValue('is_one_of', ['a', 'b']), ['a', 'b']);
});

test('normalizeConditionValue: returns empty array for is_one_of with empty value', () => {
  assert.deepEqual(normalizeConditionValue('is_one_of', ''), []);
  assert.deepEqual(normalizeConditionValue('is_one_of', null), []);
});

test('normalizeConditionValue: passes through string for regular operators', () => {
  assert.equal(normalizeConditionValue('contains', 'hello'), 'hello');
  assert.equal(normalizeConditionValue('equals', '42'), '42');
});

// ── buildFieldOptions ─────────────────────────────────────────────────────────

test('buildFieldOptions: returns empty array for null input', () => {
  assert.deepEqual(buildFieldOptions(null), []);
  assert.deepEqual(buildFieldOptions(undefined), []);
});

test('buildFieldOptions: flattens member and organisation fields', () => {
  const fieldsData = {
    member: {
      core: [{ field_key: 'first_name', label: 'First Name', data_type: 'text' }],
      custom: [],
    },
    organization: {
      core: [{ field_key: 'name', label: 'Name', data_type: 'text' }],
      custom: [],
    },
  };
  const opts = buildFieldOptions(fieldsData);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].entity_scope, 'member');
  assert.equal(opts[0].field_type, 'core');
  assert.equal(opts[0].field_key, 'first_name');
  assert.equal(opts[1].entity_scope, 'organization');
});

test('buildFieldOptions: annotates _label with scope prefix', () => {
  const fieldsData = {
    member: { core: [{ field_key: 'email', label: 'Email', data_type: 'text' }], custom: [] },
  };
  const opts = buildFieldOptions(fieldsData);
  assert.equal(opts[0]._label, 'Member · Email');
});

test('buildFieldOptions: tolerates backend sending key instead of field_key', () => {
  const fieldsData = {
    member: {
      core: [{ key: 'join_date', label: 'Join Date', data_type: 'date' }],
      custom: [],
    },
  };
  const opts = buildFieldOptions(fieldsData);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].field_key, 'join_date');
});

test('buildFieldOptions: skips entries with neither field_key nor key', () => {
  const fieldsData = {
    member: {
      core: [{ label: 'No key', data_type: 'text' }],
      custom: [],
    },
  };
  assert.equal(buildFieldOptions(fieldsData).length, 0);
});

test('buildFieldOptions: omits field for scope not in data', () => {
  const fieldsData = {
    member: { core: [{ field_key: 'email', label: 'Email', data_type: 'text' }], custom: [] },
    // organization key absent entirely
  };
  assert.equal(buildFieldOptions(fieldsData).length, 1);
});

// ── blankFilterGroup / blankCondition ─────────────────────────────────────────

test('blankFilterGroup: returns one blank condition', () => {
  const fg = blankFilterGroup();
  assert.equal(fg.conditions.length, 1);
  assert.equal(fg.conditions[0].field_key, '');
});

test('blankCondition: defaults to member scope text field with contains', () => {
  const c = blankCondition();
  assert.equal(c.entity_scope, 'member');
  assert.equal(c.data_type, 'text');
  assert.equal(c.operator, 'contains');
  assert.equal(c.value, '');
});

test('blankFilterGroup: each call returns an independent object', () => {
  const a = blankFilterGroup();
  const b = blankFilterGroup();
  a.conditions[0].field_key = 'email';
  assert.equal(b.conditions[0].field_key, '', 'blankFilterGroup must not share state');
});

// ── validateAutoConfig ────────────────────────────────────────────────────────

const VALID_COND = {
  entity_scope: 'member',
  field_type: 'core',
  field_key: 'email',
  data_type: 'text',
  operator: 'contains',
  value: '@example.com',
};

const validConfig = {
  enabled: true,
  role: 'Member',
  filterGroups: [{ conditions: [VALID_COND] }],
  availableRoles: ['Member', 'Admin'],
};

test('validateAutoConfig: returns empty array when disabled', () => {
  assert.deepEqual(validateAutoConfig({ enabled: false }), []);
});

test('validateAutoConfig: returns empty array for a valid config', () => {
  assert.deepEqual(validateAutoConfig(validConfig), []);
});

test('validateAutoConfig: errors when no role selected', () => {
  const errors = validateAutoConfig({ ...validConfig, role: '' });
  assert.ok(errors.length > 0);
  assert.ok(/role/i.test(errors[0]));
});

test('validateAutoConfig: errors when role not in availableRoles', () => {
  const errors = validateAutoConfig({ ...validConfig, role: 'Unknown' });
  assert.ok(errors.length > 0);
});

test('validateAutoConfig: ignores availableRoles check when availableRoles is empty', () => {
  // empty availableRoles means no roles defined yet — role validity not checked
  const errors = validateAutoConfig({ ...validConfig, availableRoles: [] });
  assert.deepEqual(errors, []);
});

test('validateAutoConfig: errors when no filter groups', () => {
  const errors = validateAutoConfig({ ...validConfig, filterGroups: [] });
  assert.ok(errors.length > 0);
});

test('validateAutoConfig: errors when condition has no field_key', () => {
  const errors = validateAutoConfig({
    ...validConfig,
    filterGroups: [{ conditions: [{ ...blankCondition() }] }],
  });
  assert.ok(errors.length > 0);
});

test('validateAutoConfig: errors when value is empty string for non-nullary operator', () => {
  const errors = validateAutoConfig({
    ...validConfig,
    filterGroups: [
      {
        conditions: [
          { ...VALID_COND, operator: 'contains', value: '' },
        ],
      },
    ],
  });
  assert.ok(errors.length > 0);
});

test('validateAutoConfig: errors when array value is empty for is_one_of', () => {
  const errors = validateAutoConfig({
    ...validConfig,
    filterGroups: [
      {
        conditions: [
          { entity_scope: 'member', field_type: 'core', field_key: 'status', data_type: 'select', operator: 'is_one_of', value: [] },
        ],
      },
    ],
  });
  assert.ok(errors.length > 0);
});

test('validateAutoConfig: accepts non-empty array value for is_one_of', () => {
  const errors = validateAutoConfig({
    ...validConfig,
    filterGroups: [
      {
        conditions: [
          { entity_scope: 'member', field_type: 'core', field_key: 'status', data_type: 'select', operator: 'is_one_of', value: ['active'] },
        ],
      },
    ],
  });
  assert.deepEqual(errors, []);
});

test('validateAutoConfig: allows empty value for nullary operators (is_empty)', () => {
  const errors = validateAutoConfig({
    ...validConfig,
    filterGroups: [
      {
        conditions: [
          { ...VALID_COND, operator: 'is_empty', value: '' },
        ],
      },
    ],
  });
  assert.deepEqual(errors, []);
});

test('validateAutoConfig: allows empty value for boolean nullary operators (is_true)', () => {
  const errors = validateAutoConfig({
    ...validConfig,
    filterGroups: [
      {
        conditions: [
          { entity_scope: 'member', field_type: 'core', field_key: 'active', data_type: 'boolean', operator: 'is_true', value: '' },
        ],
      },
    ],
  });
  assert.deepEqual(errors, []);
});

test('validateAutoConfig: allows empty value for boolean nullary operators (is_false)', () => {
  const errors = validateAutoConfig({
    ...validConfig,
    filterGroups: [
      {
        conditions: [
          { entity_scope: 'member', field_type: 'core', field_key: 'active', data_type: 'boolean', operator: 'is_false', value: '' },
        ],
      },
    ],
  });
  assert.deepEqual(errors, []);
});

test('validateAutoConfig: errors when filter group has no conditions', () => {
  const errors = validateAutoConfig({
    ...validConfig,
    filterGroups: [{ conditions: [] }],
  });
  assert.ok(errors.length > 0);
});

test('validateAutoConfig: accepts multiple filter groups with valid conditions', () => {
  const errors = validateAutoConfig({
    ...validConfig,
    filterGroups: [
      { conditions: [VALID_COND] },
      { conditions: [{ ...VALID_COND, field_key: 'first_name', value: 'Jane' }] },
    ],
  });
  assert.deepEqual(errors, []);
});
