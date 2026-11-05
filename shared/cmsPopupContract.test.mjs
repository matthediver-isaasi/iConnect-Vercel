import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePopupAudience, matchPopupCondition, POPUP_DEFAULT_CONFIG, popupFrequencyAllows,
  popupScheduleAvailable, validatePopupConfig, validatePopupDesign, validatePopupSchedule } from './cmsPopupContract.js';
import { tenantDateTimeToUtc } from '../client/src/lib/popupSchedule.js';

const fields = {
  member: { core: [{ key: 'first_name', data_type: 'text' }], custom: [{ key: 'age', data_type: 'number' }] },
  organization: { core: [{ key: 'name', data_type: 'text' }, { key: 'status', data_type: 'text' }], custom: [] },
};
const condition = (scope, key, value, operator = 'equals') => ({ entity_scope: scope, field_type: 'core', field_key: key, value, data_type: 'text', operator });
const config = groups => ({ ...structuredClone(POPUP_DEFAULT_CONFIG), groups: groups.map(conditions => ({ conditions })) });
const viewer = { isAuthenticated: true, memberId: 'm' };
test('same organisation must satisfy all organisation clauses within an AND group', () => {
  const c = config([[condition('organization', 'name', 'A'), condition('organization', 'status', 'active')]]);
  assert.equal(evaluatePopupAudience(c, viewer, fields, { id: 'm' }, [{ name: 'A', status: 'paused' }, { name: 'B', status: 'active' }]), false);
  assert.equal(evaluatePopupAudience(c, viewer, fields, { id: 'm' }, [{ name: 'A', status: 'active' }]), true);
});
test('invalid OR branches invalidate the whole audience, even if another branch matches', () => {
  assert.throws(() => evaluatePopupAudience(config([[condition('member', 'first_name', 'A')], [condition('member', 'deleted', 'x')]]),
    viewer, fields, { id: 'm', first_name: 'A' }), /unavailable/);
});
test('anonymous visitors and authenticated non-members never satisfy data conditions', () => {
  const c = config([[condition('member', 'first_name', '', 'is_empty')]]);
  for (const v of [{ isAuthenticated: false }, { isAuthenticated: true }]) {
    assert.equal(evaluatePopupAudience(c, v, fields, null), false);
  }
  assert.equal(evaluatePopupAudience({ ...config([]), visibility: 'guests' }, { isAuthenticated: true }, fields, null), false);
  assert.equal(evaluatePopupAudience({ ...config([]), visibility: 'members' }, { isAuthenticated: true }, fields, null), false);
});
test('null is not false, unequal or an absent list member; typed comparisons reject coercion', () => {
  for (const operator of ['not_equals', 'is_false', 'contains', 'greater_than']) assert.equal(matchPopupCondition(null, { operator, value: 'x', data_type: 'text' }), false);
  assert.equal(matchPopupCondition(null, { operator: 'is_empty' }), true);
  assert.equal(matchPopupCondition('12oops', { operator: 'greater_than', value: 10, data_type: 'number' }), false);
  assert.equal(matchPopupCondition('12', { operator: 'greater_than', value: 10, data_type: 'number' }), true);
  assert.equal(matchPopupCondition('["UK","US"]', { operator: 'contains', value: ['US'], data_type: 'countries' }), true);
});
test('schedule boundaries, lifecycle and explicit offsets', () => {
  const row = { status: 'active', starts_at: '2026-11-05T10:00:00Z', ends_at: '2026-11-05T11:00:00Z' };
  assert.equal(popupScheduleAvailable(row, Date.parse(row.starts_at)), true);
  assert.equal(popupScheduleAvailable(row, Date.parse(row.ends_at)), false);
  assert.equal(popupScheduleAvailable({ ...row, status: 'paused' }, Date.parse(row.starts_at)), false);
  assert.throws(() => validatePopupSchedule('2026-11-05T10:00', null), /offset/);
  assert.throws(() => validatePopupSchedule(row.ends_at, row.starts_at), /later/);
});
test('tenant day differs from elapsed N days; permanent opt-out wins', () => {
  const state = { last_shown_at: '2026-03-29T00:30:00Z' };
  const now = Date.parse('2026-03-29T23:15:00Z');
  assert.equal(popupFrequencyAllows({ type: 'day' }, state, 'Europe/London', now), true);
  assert.equal(popupFrequencyAllows({ type: 'n_days', days: 1 }, state, 'Europe/London', now), false);
  assert.equal(popupFrequencyAllows({ type: 'page_view' }, { permanently_dismissed: true }, 'UTC', now), false);
});
test('authoring rejects ambiguous and missing DST wall times', () => {
  assert.throws(() => tenantDateTimeToUtc('2026-03-29T01:30', 'Europe/London'), /does not exist/);
  assert.throws(() => tenantDateTimeToUtc('2026-10-25T01:30', 'Europe/London'), /twice/);
  assert.equal(tenantDateTimeToUtc('2026-07-01T12:00', 'Europe/London'), '2026-07-01T11:00:00.000Z');
});
test('config and both Canvas formats explicitly reject unsupported content', () => {
  validatePopupConfig(structuredClone(POPUP_DEFAULT_CONFIG));
  assert.throws(() => validatePopupConfig({ ...POPUP_DEFAULT_CONFIG, trigger: { type: 'delay', value: -1 } }));
  for (const version of [1, 2]) {
    validatePopupDesign({ version, root: { sections: [{ children: [{ type: 'text' }] }] } });
    assert.throws(() => validatePopupDesign({ version, root: { sections: [{ children: [{ type: 'form-embed' }] }] } }), /Unsupported/);
  }
});
