import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMembershipNominalCode } from './membershipNominalCode.js';

// Minimal supabase stub whose system_settings query resolves to `value`.
function stubSupabase(value) {
  const builder = {
    calls: {},
    select() { return builder; },
    eq(col, val) { builder.calls[col] = val; return builder; },
    async maybeSingle() { return { data: value != null ? { setting_value: value } : null }; },
  };
  return { from(table) { builder.calls.table = table; return builder; }, _builder: builder };
}

test('tier override wins over global setting', async () => {
  const supabase = stubSupabase('200');
  const code = await resolveMembershipNominalCode(supabase, 't1', { nominalCode: '4001' });
  assert.equal(code, '4001');
});

test('tier override is trimmed', async () => {
  const code = await resolveMembershipNominalCode(stubSupabase('200'), 't1', { nominalCode: '  4002  ' });
  assert.equal(code, '4002');
});

test('blank/whitespace override falls back to global membership_nominal_ledger', async () => {
  const supabase = stubSupabase(' 200 ');
  const code = await resolveMembershipNominalCode(supabase, 't1', { nominalCode: '   ' });
  assert.equal(code, '200');
  assert.equal(supabase._builder.calls.setting_key, 'membership_nominal_ledger');
  assert.equal(supabase._builder.calls.tenant_id, 't1');
});

test('null simResult falls back to global setting', async () => {
  assert.equal(await resolveMembershipNominalCode(stubSupabase('310'), 't1', null), '310');
});

test('no override and no global setting resolves to null (provider defaults)', async () => {
  assert.equal(await resolveMembershipNominalCode(stubSupabase(null), 't1', {}), null);
  assert.equal(await resolveMembershipNominalCode(stubSupabase(''), 't1', { nominalCode: null }), null);
});

// The simulation surfaces the matched pricing's nominal code with this exact
// expression (flat config vs matched band). Guard its edge cases here.
function simNominalExpression({ matchedBand, isFlat, config }) {
  return String(matchedBand?.nominal_code || (isFlat ? config.nominal_code : '') || '').trim() || null;
}

test('simulation expression: band override', () => {
  assert.equal(simNominalExpression({ matchedBand: { nominal_code: ' 4100 ' }, isFlat: false, config: {} }), '4100');
});

test('simulation expression: flat config override', () => {
  assert.equal(simNominalExpression({ matchedBand: null, isFlat: true, config: { nominal_code: '4200' } }), '4200');
});

test('simulation expression: no override yields null (never the string "null")', () => {
  assert.equal(simNominalExpression({ matchedBand: { nominal_code: null }, isFlat: false, config: { nominal_code: '9999' } }), null);
  assert.equal(simNominalExpression({ matchedBand: null, isFlat: true, config: { nominal_code: null } }), null);
});
