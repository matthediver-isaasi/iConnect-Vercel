import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscountHelper as loadHelper } from './discountHelperCore.js';

const CONFIG_ID = 'config-4380';
const TENANT_ID = 'tenant-4380';
const ENTITY_ID = 'entity-4380';
const ROI = 'Republic of Ireland';
const REGION_FIELD = 'region';

const rule = {
  id: 'discount-roi',
  config_id: CONFIG_ID,
  tenant_id: TENANT_ID,
  field_id: REGION_FIELD,
  field_label: 'Governance Region',
  match_value: ROI,
  match_condition: 'equals',
  discount_type: 'percentage',
  discount_value: '30',
  label: 'ROI discount',
  sort_order: 1,
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
        then(resolve, reject) {
          let data;
          if (table === 'membership_tier_discount') {
            data = rules;
          } else if (['organization_preference_value', 'member_preference_value'].includes(table)) {
            data = [...new Set(rules.map(candidate => candidate.field_id).filter(Boolean))]
              .map(field_id => ({ field_id, value: subject }));
          } else {
            throw new Error(`Unexpected table ${table}`);
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return { ...loadHelper(db), calls };
}

const representations = [
  ROI,
  `  ${ROI.toUpperCase()}  `,
  [ROI],
  JSON.stringify([ROI]),
  ['Scotland', ` ${ROI.toLowerCase()} `],
  JSON.stringify(['Scotland', ROI]),
];

for (const [kind, invoke, valueTable, idColumn] of [
  [
    'organisation',
    (helper, overrides) => helper.evaluateDiscountsForOrg(CONFIG_ID, TENANT_ID, ENTITY_ID, overrides),
    'organization_preference_value',
    'organization_id',
  ],
  [
    'member',
    (helper, overrides) => helper.evaluateDiscountsForEntity(
      CONFIG_ID,
      TENANT_ID,
      ENTITY_ID,
      overrides,
      'member',
    ),
    'member_preference_value',
    'member_id',
  ],
]) {
  test(`${kind}: persisted ROI JSON picklist matches the scalar control`, async () => {
    const control = await invoke(fixture(ROI), {});
    assert.equal(control.discountDetails.length, 1);
    const actual = await invoke(fixture(JSON.stringify([ROI])), {});
    assert.deepEqual(actual, control);
  });

  test(`${kind}: scalar/native/encoded arrays on both sides normalize identically`, async () => {
    for (const subject of representations) {
      for (const match_value of representations) {
        const result = await invoke(
          fixture(subject, [{ ...rule, match_value }]),
          {},
        );
        assert.equal(
          result.discountDetails.length,
          1,
          JSON.stringify({ subject, match_value }),
        );
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
      for (const match_condition of ['equals', 'not_equals']) {
        const result = await invoke(
          fixture(subject, [{ ...rule, match_value, match_condition }]),
          {},
        );
        assert.equal(
          result.discountDetails.length > 0,
          match_condition === 'equals' ? equal : !equal,
          JSON.stringify({ subject, match_value, match_condition }),
        );
      }
    }
  });

  test(`${kind}: empty, missing, and malformed selections cannot activate either condition`, async () => {
    const invalid = [
      undefined,
      null,
      '',
      '  ',
      [],
      '[]',
      [null, ' '],
      '[null,""]',
      'null',
      {},
      '{"region":"Republic of Ireland"}',
      '[oops',
      '["Republic of Ireland"',
      [ROI, {}],
      [[ROI]],
    ];

    for (const value of invalid) {
      for (const match_condition of ['equals', 'not_equals']) {
        const subjectResult = await invoke(
          fixture(value, [{ ...rule, match_condition }]),
          {},
        );
        assert.equal(
          subjectResult.discountDetails.length,
          0,
          `invalid subject ${JSON.stringify(value)} (${match_condition})`,
        );

        const ruleResult = await invoke(
          fixture(ROI, [{ ...rule, match_condition, match_value: value }]),
          {},
        );
        assert.equal(
          ruleResult.discountDetails.length,
          0,
          `invalid rule ${JSON.stringify(value)} (${match_condition})`,
        );
      }
    }
  });

  test(`${kind}: supplied values take precedence, including explicit empty selections`, async () => {
    for (const override of [ROI, [ROI], JSON.stringify([ROI])]) {
      const f = fixture('England');
      const result = await invoke(f, { [REGION_FIELD]: override });
      assert.equal(result.discountDetails.length, 1);
      assert.equal(f.calls.some(call => call.table === valueTable), false);
    }

    for (const override of ['', [], '[]']) {
      const f = fixture(ROI);
      const result = await invoke(f, { [REGION_FIELD]: override });
      assert.equal(result.discountDetails.length, 0);
      assert.equal(f.calls.some(call => call.table === valueTable), false);
    }

    // Null/undefined preserve the existing fallback to persisted values.
    for (const override of [null, undefined]) {
      const f = fixture(ROI);
      const result = await invoke(f, { [REGION_FIELD]: override });
      assert.equal(result.discountDetails.length, 1);
      assert.equal(f.calls.some(call => call.table === valueTable), true);
    }
  });

  test(`${kind}: query boundaries and ordering are preserved`, async () => {
    const secondRule = {
      ...rule,
      id: 'discount-country',
      field_id: 'country',
      match_value: 'England',
      sort_order: 2,
    };
    const f = fixture(ROI, [rule, secondRule]);
    const result = await invoke(f, {});
    assert.equal(result.discountDetails.length, 1);
    assert.deepEqual(
      f.calls[0].filters,
      [['config_id', CONFIG_ID], ['tenant_id', TENANT_ID]],
    );
    assert.deepEqual(f.calls[0].order, ['sort_order', { ascending: true }]);
    assert.deepEqual(
      f.calls[1].filters,
      [[idColumn, ENTITY_ID], ['field_id', [REGION_FIELD, 'country']]],
    );
  });

  test(`${kind}: org/member evaluation has the same matching and detail shape`, async () => {
    const organisation = await fixture(JSON.stringify([ROI])).evaluateDiscountsForOrg(
      CONFIG_ID,
      TENANT_ID,
      ENTITY_ID,
    );
    const member = await fixture(JSON.stringify([ROI])).evaluateDiscountsForEntity(
      CONFIG_ID,
      TENANT_ID,
      ENTITY_ID,
      {},
      'member',
    );
    assert.deepEqual(member.discountDetails, organisation.discountDetails);
  });
}

test('stacked percentage/fixed discounts retain per-line rounding and round the total once', () => {
  const { applyDiscountsToAnnualCost } = fixture(ROI);
  const result = applyDiscountsToAnnualCost(123.45, [
    { id: 'percentage-1', discount_type: 'percentage', discount_value: 12.34 },
    { id: 'percentage-2', discount_type: 'percentage', discount_value: 8.76 },
    { id: 'fixed-1', discount_type: 'fixed', discount_value: 1.27 },
  ]);

  assert.equal(result.totalDiscount, 27.32);
  assert.equal(result.discountedCost, 96.13);
  assert.deepEqual(
    result.appliedDiscounts.map(discount => discount.applied_amount),
    [15.23, 10.81, 1.27],
  );
});

test('empty and unsupported discount details do not change annual cost', () => {
  const { applyDiscountsToAnnualCost } = fixture(ROI);
  assert.deepEqual(
    applyDiscountsToAnnualCost(123.45, []),
    { discountedCost: 123.45, totalDiscount: 0, appliedDiscounts: [] },
  );
  assert.deepEqual(
    applyDiscountsToAnnualCost(123.45, [{ discount_type: 'unknown', discount_value: 50 }]),
    { discountedCost: 123.45, totalDiscount: 0, appliedDiscounts: [] },
  );
});