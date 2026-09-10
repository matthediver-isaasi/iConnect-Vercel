import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load the real helper with only the database dependency replaced.
const source = readFileSync(new URL('./vatOverrideHelper.js', import.meta.url), 'utf8');
function loadHelper(db) {
  return new Function('supabase', source
    .replace("import { supabase } from './database.js';", '')
    .replaceAll('export async function', 'async function')
    + '\nreturn { evaluateVatOverrideForOrg, evaluateVatOverrideForMember };')(db);
}

const ROI = 'Republic of Ireland';
const rule = {
  field_id: 'region', match_value: ROI, match_condition: 'equals',
  vat_rate: JSON.stringify({ taxType: 'ZERORATEDOUTPUT', name: 'Zero Rated Income' }),
  label: 'ROI', field_label: 'Governance Region',
};

function fixture(subject, rules = [rule]) {
  const calls = [];
  const db = {
    from(table) {
      const call = { table, filters: [] };
      calls.push(call);
      const query = {
        select() { return this; },
        eq(...args) { call.filters.push(args); return this; },
        in(...args) { call.filters.push(args); return this; },
        order(...args) { call.order = args; return this; },
        maybeSingle() { call.single = true; return this; },
        then(resolve, reject) {
          let data;
          if (table === 'membership_tier_vat_override') data = rules;
          else if (table === 'member') data = { region: subject };
          else if (['organization_preference_value', 'member_preference_value'].includes(table)) {
            data = [{ field_id: 'region', value: subject }];
          } else throw new Error(`Unexpected table ${table}`);
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { ...loadHelper(db), calls };
}

for (const [kind, method, valueTable, idColumn] of [
  ['organisation', 'evaluateVatOverrideForOrg', 'organization_preference_value', 'organization_id'],
  ['member', 'evaluateVatOverrideForMember', 'member_preference_value', 'member_id'],
]) {
  test(`${kind}: persisted ROI JSON picklist matches the scalar control`, async () => {
    const control = await fixture(ROI)[method]('config', 'tenant', 'subject');
    assert.equal(control.taxType, 'ZERORATEDOUTPUT');
    const actual = await fixture(JSON.stringify([ROI]))[method]('config', 'tenant', 'subject');
    assert.deepEqual(actual, control);
  });

  test(`${kind}: scalar/native/encoded arrays on both sides normalize identically`, async () => {
    const representations = [ROI, `  ${ROI.toUpperCase()}  `, [ROI], JSON.stringify([ROI]),
      ['Scotland', ` ${ROI.toLowerCase()} `], JSON.stringify(['Scotland', ROI])];
    for (const subject of representations) {
      for (const match_value of representations) {
        const result = await fixture(subject, [{ ...rule, match_value }])[method]('config', 'tenant', 'subject');
        assert.equal(result?.taxType, 'ZERORATEDOUTPUT', JSON.stringify({ subject, match_value }));
      }
    }
  });

  test(`${kind}: equals is any-match and not-equals is no-match`, async () => {
    for (const [subject, match_value, equal] of [
      [[ROI, 'Scotland'], [ROI, 'Wales'], true],
      [['Scotland', 'England'], [ROI, 'Wales'], false],
      ['Scotland', ROI, false],
      [[ROI, 'Scotland'], 'Republic of Ireland,Scotland', false],
    ]) {
      for (const condition of ['equals', 'not_equals']) {
        const result = await fixture(subject, [{ ...rule, match_value, match_condition: condition }])[method]('config', 'tenant', 'subject');
        assert.equal(!!result, condition === 'equals' ? equal : !equal);
      }
    }
  });

  test(`${kind}: empty, missing, and malformed selections cannot activate either condition`, async () => {
    const invalid = [undefined, null, '', '  ', [], '[]', [null, ' '], '[null,""]',
      'null', {}, '{"region":"Republic of Ireland"}', '[oops', '["Republic of Ireland"',
      [ROI, {}], [[ROI]]];
    for (const value of invalid) {
      for (const match_condition of ['equals', 'not_equals']) {
        assert.equal(await fixture(value, [{ ...rule, match_condition }])[method]('config', 'tenant', 'subject'), null,
          `invalid subject ${JSON.stringify(value)} (${match_condition})`);
        assert.equal(await fixture(ROI, [{ ...rule, match_condition, match_value: value }])[method]('config', 'tenant', 'subject'), null,
          `invalid rule ${JSON.stringify(value)} (${match_condition})`);
      }
    }
  });

  test(`${kind}: supplied values take precedence, including explicit empty selections`, async () => {
    for (const override of [ROI, [ROI], JSON.stringify([ROI])]) {
      const f = fixture('England');
      assert.equal((await f[method]('config', 'tenant', 'subject', { region: override })).taxType, 'ZERORATEDOUTPUT');
      assert.equal(f.calls.some(c => c.table === valueTable), false);
    }
    for (const override of ['', [], '[]']) {
      assert.equal(await fixture(ROI)[method]('config', 'tenant', 'subject', { region: override }), null);
    }
    // Preserve the existing null/undefined override fallback to persisted values.
    for (const override of [null, undefined]) {
      assert.equal((await fixture(ROI)[method]('config', 'tenant', 'subject', { region: override })).taxType, 'ZERORATEDOUTPUT');
    }
  });

  test(`${kind}: first matching rule and existing query boundaries are preserved`, async () => {
    const f = fixture([ROI], [
      { ...rule, match_value: 'England', label: 'Unmatched' },
      rule, { ...rule, label: 'Later', vat_rate: 'OUTPUT2' },
    ]);
    const result = await f[method]('config', 'tenant', 'subject');
    assert.equal(result.ruleLabel, 'ROI');
    assert.deepEqual(f.calls[0].filters, [['config_id', 'config'], ['tenant_id', 'tenant']]);
    assert.deepEqual(f.calls[0].order, ['sort_order', { ascending: true }]);
    assert.deepEqual(f.calls[1].filters, [[idColumn, 'subject'], ['field_id', ['region']]]);
  });
}

test('member core fields use the same array matching and override precedence', async () => {
  const rules = [{ ...rule, field_id: 'core:region' }];
  const f = fixture(JSON.stringify([ROI]), rules);
  assert.equal((await f.evaluateVatOverrideForMember('config', 'tenant', 'member')).taxType, 'ZERORATEDOUTPUT');
  assert.deepEqual(f.calls[1].filters, [['id', 'member']]);
  const overridden = fixture('England', rules);
  assert.equal((await overridden.evaluateVatOverrideForMember('config', 'tenant', 'member', { 'core:region': [ROI] })).taxType, 'ZERORATEDOUTPUT');
  assert.equal(overridden.calls.length, 1);
});