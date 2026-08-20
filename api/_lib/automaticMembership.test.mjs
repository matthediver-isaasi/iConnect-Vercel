import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateCondition,
  evaluateFilterGroups,
  validateCondition,
  validateFilterGroups,
  validateAutomaticMembershipSettings,
  planReconciliationActions,
  checkAllowMembersToLeave,
  roleExistsInGroup,
  fetchAllowedCustomFieldIdsByScope,
  buildFieldMeta,
  resolveCanonicalType,
  ALLOWED_CORE_MEMBER_KEYS,
  ALLOWED_CORE_ORG_KEYS,
  CORE_MEMBER_FIELD_TYPES,
  CORE_ORG_FIELD_TYPES,
  OPERATORS_BY_TYPE,
  ALLOWED_OPERATORS,
  normalizePreferenceFieldType,
  authorizeAutomaticMembershipPolicyWrite,
} from './automaticMembership.js';

import { shouldIncludeMissingPreferenceValue } from './automaticMembershipQuery.js';

// ---------------------------------------------------------------------------
// resolveCanonicalType
// ---------------------------------------------------------------------------

test('resolveCanonicalType: core member fields use server map', () => {
  assert.equal(resolveCanonicalType({ field_type: 'core', entity_scope: 'member', field_key: 'login_enabled' }, {}), 'boolean');
  assert.equal(resolveCanonicalType({ field_type: 'core', entity_scope: 'member', field_key: 'email' }, {}), 'text');
  assert.equal(resolveCanonicalType({ field_type: 'core', entity_scope: 'organization', field_key: 'name' }, {}), 'text');
});

test('resolveCanonicalType: ignores cond.data_type for core fields', () => {
  // Even if client sends data_type='boolean', server map takes precedence
  const cond = { field_type: 'core', entity_scope: 'member', field_key: 'email', data_type: 'boolean' };
  assert.equal(resolveCanonicalType(cond, {}), 'text');
});

test('resolveCanonicalType: custom field uses metadata map', () => {
  const meta = { member: new Map([['cf-1', { data_type: 'number', options: null }]]), organization: new Map() };
  assert.equal(resolveCanonicalType({ field_type: 'custom', entity_scope: 'member', field_key: 'cf-1' }, meta), 'number');
});

test('resolveCanonicalType: custom field unknown returns null', () => {
  const meta = { member: new Map(), organization: new Map() };
  assert.equal(resolveCanonicalType({ field_type: 'custom', entity_scope: 'member', field_key: 'unknown' }, meta), null);
});

// ---------------------------------------------------------------------------
// OPERATORS_BY_TYPE coverage
// ---------------------------------------------------------------------------

test('OPERATORS_BY_TYPE: text has text-only operators', () => {
  assert.equal(OPERATORS_BY_TYPE.text.has('contains'), true);
  assert.equal(OPERATORS_BY_TYPE.text.has('is_one_of'), false);
  assert.equal(OPERATORS_BY_TYPE.text.has('greater_than'), false);
});

test('OPERATORS_BY_TYPE: boolean does not have contains', () => {
  assert.equal(OPERATORS_BY_TYPE.boolean.has('is_true'), true);
  assert.equal(OPERATORS_BY_TYPE.boolean.has('contains'), false);
});

test('OPERATORS_BY_TYPE: number has greater_than/less_than but not contains', () => {
  assert.equal(OPERATORS_BY_TYPE.number.has('greater_than'), true);
  assert.equal(OPERATORS_BY_TYPE.number.has('less_than'), true);
  assert.equal(OPERATORS_BY_TYPE.number.has('contains'), false);
});

test('OPERATORS_BY_TYPE: date has before/after but not contains', () => {
  assert.equal(OPERATORS_BY_TYPE.date.has('before'), true);
  assert.equal(OPERATORS_BY_TYPE.date.has('after'), true);
  assert.equal(OPERATORS_BY_TYPE.date.has('contains'), false);
  assert.equal(OPERATORS_BY_TYPE.date.has('greater_than'), false);
});

test('OPERATORS_BY_TYPE: select does not have contains or greater_than', () => {
  assert.equal(OPERATORS_BY_TYPE.select.has('equals'), true);
  assert.equal(OPERATORS_BY_TYPE.select.has('is_one_of'), true);
  assert.equal(OPERATORS_BY_TYPE.select.has('contains'), false);
  assert.equal(OPERATORS_BY_TYPE.select.has('greater_than'), false);
});

test('normalizePreferenceFieldType: maps legacy controls to canonical types', () => {
  assert.equal(normalizePreferenceFieldType('checkbox'), 'boolean');
  assert.equal(normalizePreferenceFieldType('decimal'), 'number');
  assert.equal(normalizePreferenceFieldType('dropdown'), 'select');
  assert.equal(normalizePreferenceFieldType('picklist'), 'select');
  assert.equal(normalizePreferenceFieldType('countries'), 'select');
  assert.equal(normalizePreferenceFieldType('list'), 'multi_select');
  assert.equal(normalizePreferenceFieldType('long_text'), 'text');
});

test('authorizeAutomaticMembershipPolicyWrite: rejects regular-member bypasses', () => {
  assert.deepEqual(
    authorizeAutomaticMembershipPolicyWrite({
      body: { automatic_membership_enabled: true },
      isAdmin: false,
    }),
    {
      ok: false,
      status: 403,
      error: 'Only tenant administrators can configure automatic group membership.',
    },
  );
  assert.equal(
    authorizeAutomaticMembershipPolicyWrite({
      body: { allow_members_to_leave: false },
      isAdmin: false,
    }).ok,
    false,
  );
  assert.equal(
    authorizeAutomaticMembershipPolicyWrite({
      body: { automatic_membership_sync_status: 'idle' },
      isAdmin: false,
    }).ok,
    false,
  );
});

test('authorizeAutomaticMembershipPolicyWrite: permits admins and unrelated legacy writes', () => {
  assert.deepEqual(
    authorizeAutomaticMembershipPolicyWrite({
      body: { automatic_membership_enabled: true },
      isAdmin: true,
    }),
    { ok: true },
  );
  assert.deepEqual(
    authorizeAutomaticMembershipPolicyWrite({
      body: { name: 'Legacy group' },
      isAdmin: false,
    }),
    { ok: true },
  );
});

test('negative preference operators include absent and blank values', () => {
  assert.equal(shouldIncludeMissingPreferenceValue('not_equals'), true);
  assert.equal(shouldIncludeMissingPreferenceValue('is_not_one_of'), true);
  assert.equal(shouldIncludeMissingPreferenceValue('equals'), false);
  assert.equal(shouldIncludeMissingPreferenceValue('is_one_of'), false);
});

// ---------------------------------------------------------------------------
// validateCondition — basic structural checks
// ---------------------------------------------------------------------------

test('validateCondition: valid core member', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'contains', value: 'x' };
  assert.equal(validateCondition(cond), null);
});

test('validateCondition: unknown entity_scope', () => {
  const cond = { entity_scope: 'event', field_type: 'core', field_key: 'email', operator: 'equals', value: 'x' };
  assert.match(validateCondition(cond), /entity_scope/);
});

test('validateCondition: unknown operator', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'regex', value: 'x' };
  assert.match(validateCondition(cond), /operator/);
});

test('validateCondition: core member key not in allowlist', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'internal_notes', operator: 'equals', value: 'x' };
  assert.match(validateCondition(cond), /allowlist/);
});

test('validateCondition: unknown field_type', () => {
  const cond = { entity_scope: 'member', field_type: 'derived', field_key: 'x', operator: 'equals', value: 'x' };
  assert.match(validateCondition(cond), /field_type/);
});

// ---------------------------------------------------------------------------
// validateCondition — operator vs canonical type enforcement
// ---------------------------------------------------------------------------

test('validateCondition: contains valid for text field', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'contains', value: 'test' };
  assert.equal(validateCondition(cond), null);
});

test('validateCondition: greater_than invalid for text core field', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'greater_than', value: '5' };
  const err = validateCondition(cond);
  assert.ok(err, 'should return an error');
  assert.match(err, /not valid.*text/);
});

test('validateCondition: is_true invalid for text field', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'is_true' };
  assert.match(validateCondition(cond) || '', /not valid.*text/);
});

test('validateCondition: is_true valid for boolean field', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'login_enabled', operator: 'is_true' };
  assert.equal(validateCondition(cond), null);
});

test('validateCondition: contains invalid for boolean field', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'login_enabled', operator: 'contains', value: 'x' };
  assert.match(validateCondition(cond) || '', /not valid.*boolean/);
});

test('validateCondition: greater_than valid for custom number field', () => {
  const meta = { member: new Map([['cf-num', { data_type: 'number', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-num', operator: 'greater_than', value: 5 };
  assert.equal(validateCondition(cond, { member: new Set(['cf-num']), organization: new Set() }, meta), null);
});

test('validateCondition: contains invalid for custom number field', () => {
  const meta = { member: new Map([['cf-num', { data_type: 'number', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-num', operator: 'contains', value: 'x' };
  const err = validateCondition(cond, { member: new Set(['cf-num']), organization: new Set() }, meta);
  assert.match(err, /not valid.*number/);
});

test('validateCondition: before valid for date field', () => {
  const meta = { member: new Map([['cf-date', { data_type: 'date', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-date', operator: 'before', value: '2025-01-01' };
  assert.equal(validateCondition(cond, { member: new Set(['cf-date']), organization: new Set() }, meta), null);
});

test('validateCondition: greater_than invalid for date field', () => {
  const meta = { member: new Map([['cf-date', { data_type: 'date', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-date', operator: 'greater_than', value: '2025-01-01' };
  const err = validateCondition(cond, { member: new Set(['cf-date']), organization: new Set() }, meta);
  assert.match(err, /not valid.*date/);
});

// ---------------------------------------------------------------------------
// validateCondition — value shape validation
// ---------------------------------------------------------------------------

test('validateCondition: nullary operator requires no value', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'login_enabled', operator: 'is_true' };
  assert.equal(validateCondition(cond), null); // no value fine
});

test('validateCondition: scalar operator requires value', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'equals', value: null };
  assert.match(validateCondition(cond), /requires a value/);
});

test('validateCondition: is_one_of requires non-empty array', () => {
  const allowed = { member: new Set(['cf-select']), organization: new Set() };
  const meta = { member: new Map([['cf-select', { data_type: 'select', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-select', operator: 'is_one_of', value: [] };
  assert.match(validateCondition(cond, allowed, meta), /non-empty array/);
});

test('validateCondition: is_not_one_of requires array', () => {
  const allowed = { member: new Set(['cf-select']), organization: new Set() };
  const meta = { member: new Map([['cf-select', { data_type: 'select', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-select', operator: 'is_not_one_of', value: 'x' };
  assert.match(validateCondition(cond, allowed, meta), /non-empty array/);
});

test('validateCondition: is_one_of valid with array', () => {
  const allowed = { member: new Set(['cf-select']), organization: new Set() };
  const meta = { member: new Map([['cf-select', { data_type: 'select', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-select', operator: 'is_one_of', value: ['a', 'b'] };
  assert.equal(validateCondition(cond, allowed, meta), null);
});

// ---------------------------------------------------------------------------
// validateCondition — numeric value validation
// ---------------------------------------------------------------------------

test('validateCondition: finite number passes for number field', () => {
  const meta = { member: new Map([['cf-n', { data_type: 'number', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-n', operator: 'greater_than', value: 42 };
  assert.equal(validateCondition(cond, { member: new Set(['cf-n']), organization: new Set() }, meta), null);
});

test('validateCondition: Infinity rejected for number field', () => {
  const meta = { member: new Map([['cf-n', { data_type: 'number', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-n', operator: 'greater_than', value: Infinity };
  assert.match(validateCondition(cond, { member: new Set(['cf-n']), organization: new Set() }, meta), /finite/);
});

test('validateCondition: NaN-string rejected for number field', () => {
  const meta = { member: new Map([['cf-n', { data_type: 'number', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-n', operator: 'less_than', value: 'abc' };
  assert.match(validateCondition(cond, { member: new Set(['cf-n']), organization: new Set() }, meta), /finite/);
});

// ---------------------------------------------------------------------------
// validateCondition — date value validation (ISO YYYY-MM-DD)
// ---------------------------------------------------------------------------

test('validateCondition: valid ISO date passes', () => {
  const meta = { member: new Map([['cf-d', { data_type: 'date', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-d', operator: 'after', value: '2024-06-01' };
  assert.equal(validateCondition(cond, { member: new Set(['cf-d']), organization: new Set() }, meta), null);
});

test('validateCondition: non-ISO date rejected', () => {
  const meta = { member: new Map([['cf-d', { data_type: 'date', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-d', operator: 'after', value: '06/01/2024' };
  assert.match(validateCondition(cond, { member: new Set(['cf-d']), organization: new Set() }, meta), /YYYY-MM-DD/);
});

test('validateCondition: date with time rejected (no time component)', () => {
  const meta = { member: new Map([['cf-d', { data_type: 'date', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-d', operator: 'before', value: '2024-06-01T00:00:00' };
  assert.match(validateCondition(cond, { member: new Set(['cf-d']), organization: new Set() }, meta), /YYYY-MM-DD/);
});

// ---------------------------------------------------------------------------
// validateCondition — options validation for select fields
// ---------------------------------------------------------------------------

test('validateCondition: valid select value passes', () => {
  const opts = [{ value: 'gold' }, { value: 'silver' }];
  const meta = { member: new Map([['cf-sel', { data_type: 'select', options: opts }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-sel', operator: 'equals', value: 'gold' };
  assert.equal(validateCondition(cond, { member: new Set(['cf-sel']), organization: new Set() }, meta), null);
});

test('validateCondition: invalid select value rejected', () => {
  const opts = [{ value: 'gold' }, { value: 'silver' }];
  const meta = { member: new Map([['cf-sel', { data_type: 'select', options: opts }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-sel', operator: 'equals', value: 'platinum' };
  assert.match(validateCondition(cond, { member: new Set(['cf-sel']), organization: new Set() }, meta), /not a valid option/);
});

test('validateCondition: is_one_of with all valid options passes', () => {
  const opts = [{ value: 'gold' }, { value: 'silver' }];
  const meta = { member: new Map([['cf-sel', { data_type: 'select', options: opts }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-sel', operator: 'is_one_of', value: ['gold', 'silver'] };
  assert.equal(validateCondition(cond, { member: new Set(['cf-sel']), organization: new Set() }, meta), null);
});

test('validateCondition: is_one_of with invalid option rejected', () => {
  const opts = [{ value: 'gold' }, { value: 'silver' }];
  const meta = { member: new Map([['cf-sel', { data_type: 'select', options: opts }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-sel', operator: 'is_one_of', value: ['gold', 'bronze'] };
  assert.match(validateCondition(cond, { member: new Set(['cf-sel']), organization: new Set() }, meta), /not a valid option/);
});

test('validateCondition: select without configured options skips options check', () => {
  const meta = { member: new Map([['cf-sel', { data_type: 'select', options: null }]]), organization: new Map() };
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-sel', operator: 'equals', value: 'anything' };
  assert.equal(validateCondition(cond, { member: new Set(['cf-sel']), organization: new Set() }, meta), null);
});

// ---------------------------------------------------------------------------
// validateCondition — scope-aware custom field checking
// ---------------------------------------------------------------------------

test('validateCondition: custom field in plain Set (member scope compat)', () => {
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'cf-123', operator: 'equals', value: 'x' };
  assert.equal(validateCondition(cond, new Set(['cf-123'])), null);
});

test('validateCondition: custom field not in plain Set', () => {
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'unknown', operator: 'equals', value: 'x' };
  assert.match(validateCondition(cond, new Set(['cf-123'])), /tenant-owned/);
});

test('validateCondition: member custom field in member scope passes (scope-keyed)', () => {
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'mf-1', operator: 'equals', value: 'x' };
  assert.equal(validateCondition(cond, { member: new Set(['mf-1']), organization: new Set() }), null);
});

test('validateCondition: org custom field in org scope passes (scope-keyed)', () => {
  const cond = { entity_scope: 'organization', field_type: 'custom', field_key: 'of-1', operator: 'equals', value: 'x' };
  assert.equal(validateCondition(cond, { member: new Set(), organization: new Set(['of-1']) }), null);
});

test('validateCondition: member custom field ID rejected in org scope', () => {
  const cond = { entity_scope: 'organization', field_type: 'custom', field_key: 'mf-1', operator: 'equals', value: 'x' };
  assert.match(validateCondition(cond, { member: new Set(['mf-1']), organization: new Set() }), /tenant-owned/);
});

test('validateCondition: org custom field ID rejected in member scope', () => {
  const cond = { entity_scope: 'member', field_type: 'custom', field_key: 'of-1', operator: 'equals', value: 'x' };
  assert.match(validateCondition(cond, { member: new Set(), organization: new Set(['of-1']) }), /tenant-owned/);
});

// ---------------------------------------------------------------------------
// validateFilterGroups
// ---------------------------------------------------------------------------

test('validateFilterGroups: valid groups', () => {
  const fg = [{
    conditions: [{ entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'is_not_empty' }],
  }];
  assert.deepEqual(validateFilterGroups(fg), { ok: true });
});

test('validateFilterGroups: empty array is valid', () => {
  assert.deepEqual(validateFilterGroups([]), { ok: true });
});

test('validateFilterGroups: non-array', () => {
  const r = validateFilterGroups('bad');
  assert.equal(r.ok, false);
  assert.match(r.error, /array/);
});

test('validateFilterGroups: group with empty conditions', () => {
  const r = validateFilterGroups([{ conditions: [] }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /non-empty/);
});

test('validateFilterGroups: propagates operator/type error', () => {
  const fg = [{
    conditions: [{ entity_scope: 'member', field_type: 'core', field_key: 'login_enabled', operator: 'contains', value: 'x' }],
  }];
  const r = validateFilterGroups(fg);
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid.*boolean/);
});

test('validateFilterGroups: org custom field in org scope passes', () => {
  const fg = [{
    conditions: [{
      entity_scope: 'organization', field_type: 'custom',
      field_key: 'of-1', operator: 'equals', value: 'x',
    }],
  }];
  const r = validateFilterGroups(fg, { member: new Set(), organization: new Set(['of-1']) });
  assert.deepEqual(r, { ok: true });
});

test('validateFilterGroups: member field used in org condition fails (scope isolation)', () => {
  const fg = [{
    conditions: [{
      entity_scope: 'organization', field_type: 'custom',
      field_key: 'mf-1', operator: 'equals', value: 'x',
    }],
  }];
  const r = validateFilterGroups(fg, { member: new Set(['mf-1']), organization: new Set() });
  assert.equal(r.ok, false);
  assert.match(r.error, /tenant-owned/);
});

// ---------------------------------------------------------------------------
// validateAutomaticMembershipSettings
// ---------------------------------------------------------------------------

test('validateAutomaticMembershipSettings: disabled passes without checks', async () => {
  const r = await validateAutomaticMembershipSettings({ automatic_membership_enabled: false });
  assert.deepEqual(r, { ok: true });
});

test('validateAutomaticMembershipSettings: enabled but no role', async () => {
  const row = {
    automatic_membership_enabled: true,
    automatic_membership_role: '',
    automatic_membership_filter_groups: [{
      conditions: [{ entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'is_not_empty' }],
    }],
  };
  const r = await validateAutomaticMembershipSettings(row);
  assert.equal(r.ok, false);
  assert.match(r.error, /role/);
});

test('validateAutomaticMembershipSettings: enabled but no filter groups', async () => {
  const row = {
    automatic_membership_enabled: true,
    automatic_membership_role: 'Member',
    automatic_membership_filter_groups: [],
  };
  const r = await validateAutomaticMembershipSettings(row);
  assert.equal(r.ok, false);
  assert.match(r.error, /filter_groups/);
});

test('validateAutomaticMembershipSettings: valid config', async () => {
  const row = {
    automatic_membership_enabled: true,
    automatic_membership_role: 'Member',
    automatic_membership_filter_groups: [{
      conditions: [{ entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'is_not_empty' }],
    }],
  };
  const r = await validateAutomaticMembershipSettings(row, { roleExists: async () => true });
  assert.deepEqual(r, { ok: true });
});

test('validateAutomaticMembershipSettings: role not found in group', async () => {
  const row = {
    automatic_membership_enabled: true,
    automatic_membership_role: 'Ghost',
    automatic_membership_filter_groups: [{
      conditions: [{ entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'is_not_empty' }],
    }],
  };
  const r = await validateAutomaticMembershipSettings(row, { roleExists: async () => false });
  assert.equal(r.ok, false);
  assert.match(r.error, /role/);
});

test('validateAutomaticMembershipSettings: operator type mismatch propagated', async () => {
  const row = {
    automatic_membership_enabled: true,
    automatic_membership_role: 'Member',
    automatic_membership_filter_groups: [{
      conditions: [{
        entity_scope: 'member', field_type: 'core',
        field_key: 'login_enabled', operator: 'contains', value: 'x',
      }],
    }],
  };
  const r = await validateAutomaticMembershipSettings(row, { roleExists: async () => true });
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid.*boolean/);
});

test('validateAutomaticMembershipSettings: invalid custom field (scope-keyed)', async () => {
  const row = {
    automatic_membership_enabled: true,
    automatic_membership_role: 'Member',
    automatic_membership_filter_groups: [{
      conditions: [{
        entity_scope: 'member', field_type: 'custom',
        field_key: 'bad-id', operator: 'equals', value: 'x',
      }],
    }],
  };
  const r = await validateAutomaticMembershipSettings(row, {
    allowedCustomFieldIdsByScope: { member: new Set(['valid-id']), organization: new Set() },
    roleExists: async () => true,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /tenant-owned/);
});

test('validateAutomaticMembershipSettings: org custom field in org condition passes (scope-keyed)', async () => {
  const row = {
    automatic_membership_enabled: true,
    automatic_membership_role: 'Member',
    automatic_membership_filter_groups: [{
      conditions: [{
        entity_scope: 'organization', field_type: 'custom',
        field_key: 'of-1', operator: 'equals', value: 'x',
      }],
    }],
  };
  const r = await validateAutomaticMembershipSettings(row, {
    allowedCustomFieldIdsByScope: { member: new Set(), organization: new Set(['of-1']) },
    roleExists: async () => true,
  });
  assert.deepEqual(r, { ok: true });
});

test('validateAutomaticMembershipSettings: member field in org condition fails', async () => {
  const row = {
    automatic_membership_enabled: true,
    automatic_membership_role: 'Member',
    automatic_membership_filter_groups: [{
      conditions: [{
        entity_scope: 'organization', field_type: 'custom',
        field_key: 'mf-1', operator: 'equals', value: 'x',
      }],
    }],
  };
  const r = await validateAutomaticMembershipSettings(row, {
    allowedCustomFieldIdsByScope: { member: new Set(['mf-1']), organization: new Set() },
    roleExists: async () => true,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /tenant-owned/);
});

test('validateAutomaticMembershipSettings: NaN number value rejected', async () => {
  const row = {
    automatic_membership_enabled: true,
    automatic_membership_role: 'Member',
    automatic_membership_filter_groups: [{
      conditions: [{
        entity_scope: 'member', field_type: 'custom',
        field_key: 'cf-n', operator: 'greater_than', value: 'not-a-number',
      }],
    }],
  };
  const meta = { member: new Map([['cf-n', { data_type: 'number', options: null }]]), organization: new Map() };
  const r = await validateAutomaticMembershipSettings(row, {
    allowedCustomFieldIdsByScope: { member: new Set(['cf-n']), organization: new Set() },
    fieldMeta: meta,
    roleExists: async () => true,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /finite/);
});

// ---------------------------------------------------------------------------
// fetchAllowedCustomFieldIdsByScope + buildFieldMeta
// ---------------------------------------------------------------------------

test('fetchAllowedCustomFieldIdsByScope: splits by scope with metadata', async () => {
  const fakeClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            data: [
              { id: 'mf-1', entity_scope: 'member',       field_type: 'text',   options: null },
              { id: 'mf-2', entity_scope: 'member',       field_type: 'number', options: null },
              { id: 'of-1', entity_scope: 'organization', field_type: 'select', options: [{ value: 'a' }] },
            ],
            error: null,
          }),
        }),
      }),
    }),
  };
  const result = await fetchAllowedCustomFieldIdsByScope(fakeClient, 'tenant-1');
  assert.equal(result.member.has('mf-1'), true);
  assert.equal(result.member.has('mf-2'), true);
  assert.equal(result.organization.has('of-1'), true);
  assert.equal(result.organization.has('mf-1'), false);
  assert.equal(result.member.has('of-1'), false);
  // metadata maps
  assert.equal(result.memberTypes.get('mf-2')?.data_type, 'number');
  assert.equal(result.organizationTypes.get('of-1')?.data_type, 'select');
  assert.deepEqual(result.organizationTypes.get('of-1')?.options, [{ value: 'a' }]);
});

test('fetchAllowedCustomFieldIdsByScope: returns empty on DB error', async () => {
  const fakeClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ data: null, error: { message: 'connection error' } }),
        }),
      }),
    }),
  };
  const result = await fetchAllowedCustomFieldIdsByScope(fakeClient, 'tenant-1');
  assert.equal(result.member.size, 0);
  assert.equal(result.organization.size, 0);
  assert.equal(result.memberTypes.size, 0);
  assert.equal(result.organizationTypes.size, 0);
});

test('buildFieldMeta: returns Maps from scopeResult', () => {
  const scopeResult = {
    memberTypes: new Map([['cf-1', { data_type: 'text', options: null }]]),
    organizationTypes: new Map([['of-1', { data_type: 'select', options: [] }]]),
  };
  const meta = buildFieldMeta(scopeResult);
  assert.ok(meta.member instanceof Map);
  assert.ok(meta.organization instanceof Map);
  assert.equal(meta.member.get('cf-1')?.data_type, 'text');
  assert.equal(meta.organization.get('of-1')?.data_type, 'select');
});

test('buildFieldMeta: handles missing Maps gracefully', () => {
  const meta = buildFieldMeta({});
  assert.ok(meta.member instanceof Map);
  assert.ok(meta.organization instanceof Map);
  assert.equal(meta.member.size, 0);
  assert.equal(meta.organization.size, 0);
});

// ---------------------------------------------------------------------------
// evaluateCondition — typed operators
// ---------------------------------------------------------------------------

test('evaluateCondition: equals string match', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'first_name', operator: 'equals', value: 'Alice' };
  assert.equal(evaluateCondition(cond, { first_name: 'Alice' }), true);
  assert.equal(evaluateCondition(cond, { first_name: 'Bob' }), false);
});

test('evaluateCondition: not_equals', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'not_equals', value: 'a@b.com' };
  assert.equal(evaluateCondition(cond, { email: 'x@y.com' }), true);
  assert.equal(evaluateCondition(cond, { email: 'a@b.com' }), false);
});

test('evaluateCondition: contains case-insensitive', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'job_title', operator: 'contains', value: 'manager' };
  assert.equal(evaluateCondition(cond, { job_title: 'Senior Manager' }), true);
  assert.equal(evaluateCondition(cond, { job_title: 'Developer' }), false);
});

test('evaluateCondition: is_empty', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'job_title', operator: 'is_empty' };
  assert.equal(evaluateCondition(cond, { job_title: null }), true);
  assert.equal(evaluateCondition(cond, { job_title: '' }), true);
  assert.equal(evaluateCondition(cond, { job_title: 'CEO' }), false);
});

test('evaluateCondition: is_not_empty', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'job_title', operator: 'is_not_empty' };
  assert.equal(evaluateCondition(cond, { job_title: 'CEO' }), true);
  assert.equal(evaluateCondition(cond, { job_title: null }), false);
  assert.equal(evaluateCondition(cond, { job_title: '' }), false);
});

test('evaluateCondition: is_true / is_false', () => {
  const condT = { entity_scope: 'member', field_type: 'core', field_key: 'login_enabled', operator: 'is_true' };
  const condF = { entity_scope: 'member', field_type: 'core', field_key: 'login_enabled', operator: 'is_false' };
  assert.equal(evaluateCondition(condT, { login_enabled: true }), true);
  assert.equal(evaluateCondition(condT, { login_enabled: false }), false);
  assert.equal(evaluateCondition(condF, { login_enabled: false }), true);
  assert.equal(evaluateCondition(condF, { login_enabled: null }), true);
});

test('evaluateCondition: greater_than / less_than numeric custom', () => {
  const condGt = { entity_scope: 'member', field_type: 'custom', field_key: 'cf1', operator: 'greater_than', value: 5 };
  const condLt = { entity_scope: 'member', field_type: 'custom', field_key: 'cf1', operator: 'less_than', value: 5 };
  assert.equal(evaluateCondition(condGt, {}, null, { cf1: '10' }), true);
  assert.equal(evaluateCondition(condGt, {}, null, { cf1: '3' }), false);
  assert.equal(evaluateCondition(condLt, {}, null, { cf1: '2' }), true);
  assert.equal(evaluateCondition(condLt, {}, null, { cf1: '8' }), false);
});

test('evaluateCondition: before / after date string', () => {
  const condB = { entity_scope: 'member', field_type: 'custom', field_key: 'cf1', operator: 'before', value: '2025-01-01' };
  const condA = { entity_scope: 'member', field_type: 'custom', field_key: 'cf1', operator: 'after',  value: '2025-01-01' };
  assert.equal(evaluateCondition(condB, {}, null, { cf1: '2024-06-01' }), true);
  assert.equal(evaluateCondition(condB, {}, null, { cf1: '2026-01-01' }), false);
  assert.equal(evaluateCondition(condA, {}, null, { cf1: '2026-01-01' }), true);
  assert.equal(evaluateCondition(condA, {}, null, { cf1: '2024-06-01' }), false);
});

test('evaluateCondition: is_one_of', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'role_id', operator: 'is_one_of', value: ['r1', 'r2'] };
  assert.equal(evaluateCondition(cond, { role_id: 'r1' }), true);
  assert.equal(evaluateCondition(cond, { role_id: 'r3' }), false);
});

test('evaluateCondition: is_not_one_of', () => {
  const cond = { entity_scope: 'member', field_type: 'core', field_key: 'role_id', operator: 'is_not_one_of', value: ['r1', 'r2'] };
  assert.equal(evaluateCondition(cond, { role_id: 'r3' }), true);
  assert.equal(evaluateCondition(cond, { role_id: 'r1' }), false);
});

test('evaluateCondition: organization scope core field', () => {
  const cond = { entity_scope: 'organization', field_type: 'core', field_key: 'status', operator: 'equals', value: 'active' };
  assert.equal(evaluateCondition(cond, {}, { status: 'active' }), true);
  assert.equal(evaluateCondition(cond, {}, { status: 'inactive' }), false);
  assert.equal(evaluateCondition(cond, {}, null), false);
});

test('evaluateCondition: organization scope custom field', () => {
  const cond = { entity_scope: 'organization', field_type: 'custom', field_key: 'cf_org1', operator: 'equals', value: 'gold' };
  assert.equal(evaluateCondition(cond, {}, {}, {}, { cf_org1: 'gold' }), true);
  assert.equal(evaluateCondition(cond, {}, {}, {}, { cf_org1: 'silver' }), false);
});

// ---------------------------------------------------------------------------
// evaluateFilterGroups
// ---------------------------------------------------------------------------

test('evaluateFilterGroups: single group AND', () => {
  const fg = [{
    conditions: [
      { entity_scope: 'member', field_type: 'core', field_key: 'first_name', operator: 'equals', value: 'Alice' },
      { entity_scope: 'member', field_type: 'core', field_key: 'login_enabled', operator: 'is_true' },
    ],
  }];
  assert.equal(evaluateFilterGroups(fg, { first_name: 'Alice', login_enabled: true }), true);
  assert.equal(evaluateFilterGroups(fg, { first_name: 'Alice', login_enabled: false }), false);
});

test('evaluateFilterGroups: two groups OR', () => {
  const fg = [
    { conditions: [{ entity_scope: 'member', field_type: 'core', field_key: 'first_name', operator: 'equals', value: 'Alice' }] },
    { conditions: [{ entity_scope: 'member', field_type: 'core', field_key: 'last_name', operator: 'equals', value: 'Smith' }] },
  ];
  assert.equal(evaluateFilterGroups(fg, { first_name: 'Bob', last_name: 'Smith' }), true);
  assert.equal(evaluateFilterGroups(fg, { first_name: 'Alice', last_name: 'Jones' }), true);
  assert.equal(evaluateFilterGroups(fg, { first_name: 'Bob', last_name: 'Jones' }), false);
});

test('evaluateFilterGroups: empty returns false', () => {
  assert.equal(evaluateFilterGroups([], {}), false);
  assert.equal(evaluateFilterGroups(null, {}), false);
});

test('evaluateFilterGroups: group with no conditions skipped', () => {
  const fg = [
    { conditions: [] },
    { conditions: [{ entity_scope: 'member', field_type: 'core', field_key: 'email', operator: 'equals', value: 'x@x.com' }] },
  ];
  assert.equal(evaluateFilterGroups(fg, { email: 'x@x.com' }), true);
  assert.equal(evaluateFilterGroups(fg, { email: 'other@x.com' }), false);
});

// ---------------------------------------------------------------------------
// planReconciliationActions — 4-argument signature with isFinalBatch
// ---------------------------------------------------------------------------

test('planReconciliationActions: insert new members', () => {
  const batch   = ['m1', 'm2', 'm3'];
  const full    = ['m1', 'm2', 'm3'];
  const current = [{ id: 'a1', member_id: 'm1', assignment_source: 'manual' }];
  const { toInsert, toDelete } = planReconciliationActions(batch, full, current, true);
  assert.deepEqual(toInsert.sort(), ['m2', 'm3']);
  assert.deepEqual(toDelete, []);
});

test('planReconciliationActions: delete stale automatic rows on final batch', () => {
  const batch   = ['m1'];
  const full    = ['m1'];
  const current = [
    { id: 'a1', member_id: 'm1', assignment_source: 'automatic' },
    { id: 'a2', member_id: 'm2', assignment_source: 'automatic' },
    { id: 'a3', member_id: 'm3', assignment_source: 'manual' },
  ];
  const { toInsert, toDelete } = planReconciliationActions(batch, full, current, true);
  assert.deepEqual(toInsert, []);
  assert.deepEqual(toDelete, ['a2']); // m3 manual — preserved
});

test('planReconciliationActions: no deletes on non-final batch', () => {
  const batch   = ['m1'];
  const full    = ['m1', 'm2', 'm3']; // more pages remain
  const current = [
    { id: 'a1', member_id: 'm1', assignment_source: 'automatic' },
    { id: 'a2', member_id: 'm9', assignment_source: 'automatic' }, // stale but not deleted yet
  ];
  const { toDelete } = planReconciliationActions(batch, full, current, false);
  assert.deepEqual(toDelete, []);
});

test('planReconciliationActions: preserves self_join rows', () => {
  const batch   = ['m1'];
  const full    = ['m1'];
  const current = [
    { id: 'a1', member_id: 'm2', assignment_source: 'self_join' },
    { id: 'a2', member_id: 'm3', assignment_source: 'automatic' },
  ];
  const { toInsert, toDelete } = planReconciliationActions(batch, full, current, true);
  assert.deepEqual(toInsert, ['m1']);
  assert.deepEqual(toDelete, ['a2']); // a1 self_join not deleted
});

test('planReconciliationActions: idempotent', () => {
  const batch   = ['m1', 'm2'];
  const full    = ['m1', 'm2'];
  const current = [
    { id: 'a1', member_id: 'm1', assignment_source: 'automatic' },
    { id: 'a2', member_id: 'm2', assignment_source: 'automatic' },
  ];
  const { toInsert, toDelete } = planReconciliationActions(batch, full, current, true);
  assert.deepEqual(toInsert, []);
  assert.deepEqual(toDelete, []);
});

test('planReconciliationActions: empty target removes all automatic on final', () => {
  const current = [
    { id: 'a1', member_id: 'm1', assignment_source: 'automatic' },
    { id: 'a2', member_id: 'm2', assignment_source: 'manual' },
  ];
  const { toInsert, toDelete } = planReconciliationActions([], [], current, true);
  assert.deepEqual(toInsert, []);
  assert.deepEqual(toDelete, ['a1']);
});

test('planReconciliationActions: already assigned manually — not re-inserted', () => {
  const batch   = ['m1'];
  const full    = ['m1'];
  const current = [{ id: 'a1', member_id: 'm1', assignment_source: 'manual' }];
  const { toInsert, toDelete } = planReconciliationActions(batch, full, current, true);
  assert.deepEqual(toInsert, []);
  assert.deepEqual(toDelete, []);
});

test('planReconciliationActions: isFinalBatch defaults to true (backward compat)', () => {
  const current = [{ id: 'a1', member_id: 'm1', assignment_source: 'automatic' }];
  const { toDelete } = planReconciliationActions([], [], current);
  assert.deepEqual(toDelete, ['a1']);
});

test('planReconciliationActions: null currentAssignments handled safely', () => {
  const { toInsert, toDelete } = planReconciliationActions(['m1'], ['m1'], null, true);
  assert.deepEqual(toInsert, ['m1']);
  assert.deepEqual(toDelete, []);
});

// ---------------------------------------------------------------------------
// checkAllowMembersToLeave
// ---------------------------------------------------------------------------

test('checkAllowMembersToLeave: admin always allowed', () => {
  assert.deepEqual(checkAllowMembersToLeave({ allowMembersToLeave: false, isAdmin: true, isSelf: true }), { ok: true });
});

test('checkAllowMembersToLeave: non-admin self-leave blocked when disallowed', () => {
  const r = checkAllowMembersToLeave({ allowMembersToLeave: false, isAdmin: false, isSelf: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /not allowed/);
});

test('checkAllowMembersToLeave: non-admin self-leave allowed when flag is true', () => {
  assert.deepEqual(checkAllowMembersToLeave({ allowMembersToLeave: true, isAdmin: false, isSelf: true }), { ok: true });
});

test('checkAllowMembersToLeave: non-self non-admin always allowed', () => {
  assert.deepEqual(checkAllowMembersToLeave({ allowMembersToLeave: false, isAdmin: false, isSelf: false }), { ok: true });
});

// ---------------------------------------------------------------------------
// roleExistsInGroup
// ---------------------------------------------------------------------------

test('roleExistsInGroup: role in array', () => {
  assert.equal(roleExistsInGroup('Member', ['Chair', 'Member', 'Observer']), true);
});

test('roleExistsInGroup: role not in array', () => {
  assert.equal(roleExistsInGroup('Ghost', ['Chair', 'Member']), false);
});

test('roleExistsInGroup: empty array', () => {
  assert.equal(roleExistsInGroup('Member', []), false);
});

test('roleExistsInGroup: non-array returns false', () => {
  assert.equal(roleExistsInGroup('Member', null), false);
});

// ---------------------------------------------------------------------------
// Allowlists + type maps
// ---------------------------------------------------------------------------

test('ALLOWED_CORE_MEMBER_KEYS contains all required fields', () => {
  for (const k of ['first_name', 'last_name', 'email', 'job_title', 'role_id', 'login_enabled', 'communications_opted_out_all']) {
    assert.equal(ALLOWED_CORE_MEMBER_KEYS.has(k), true, `missing: ${k}`);
  }
});

test('ALLOWED_CORE_ORG_KEYS contains all required fields', () => {
  for (const k of ['name', 'status']) {
    assert.equal(ALLOWED_CORE_ORG_KEYS.has(k), true, `missing: ${k}`);
  }
});

test('CORE_MEMBER_FIELD_TYPES matches allowlist', () => {
  for (const k of ALLOWED_CORE_MEMBER_KEYS) {
    assert.ok(k in CORE_MEMBER_FIELD_TYPES, `CORE_MEMBER_FIELD_TYPES missing: ${k}`);
  }
});

test('CORE_ORG_FIELD_TYPES matches allowlist', () => {
  for (const k of ALLOWED_CORE_ORG_KEYS) {
    assert.ok(k in CORE_ORG_FIELD_TYPES, `CORE_ORG_FIELD_TYPES missing: ${k}`);
  }
});
