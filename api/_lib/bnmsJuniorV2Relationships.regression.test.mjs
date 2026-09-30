import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConditionalFilter, conditionalSelectionAllowed } from './formConditionalFilters.js';
import {
  createFormRelationshipService,
  FormRelationshipError,
} from './formRelationshipOptions.js';
import { validatePaymentRelationships } from '../public/form-payment.js';
import {
  membershipQuoteKey,
  resolveMembershipMatch,
} from '../../client/src/lib/formPaymentQuote.js';

// Minimal fixture copied from the saved "Full member junior join v2" form and
// answer JSON. Deliberately keep only fields involved in this regression.
const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const TRUST = 'a3bab40a-e50d-429a-8efe-90df8a3ebbfb';
const EXCLUDED_TRUST = 'ab07662d-19d2-41c3-97de-402909a2d0f1';
const SITE = '4f5b6a3c-927c-41a3-aba3-6fa8a98736ea';
const OTHER_SITE = 'site-under-another-trust';
const DEPARTMENT = 'department-1';
const OTHER_DEPARTMENT = 'department-under-another-site';
const OBJECT = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
const DISPLAY_FIELD = '35e4f2dd-6f22-4875-8d2f-4ffb05b1980f';
const DEFINITION = '30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e';

const ids = {
  country: 'field_1786371332409',
  trust: 'field_1787932022165',
  worksAtSites: 'field_1788073468956',
  site: 'field_1788075690796',
  department: 'field_1788075892819',
  hasOtherSites: 'field_1788675459698',
  rows: 'field_1788674418554',
  rowSite: 'row_field_1788674468526_amaga',
  rowDepartment: 'row_field_1788674529062_so7ep',
  memberClass: 'field_1786367685995',
};

const relationshipMetadata = {
  options: [],
  related_kind: 'custom_object',
  selection_mode: 'multiple',
  custom_object_id: OBJECT,
  related_custom_object_id: OBJECT,
  relationship_definition_id: DEFINITION,
  relationship_parent_kind: 'organization',
  relationship_parent_side: 'target',
  relationship_parent_custom_object_id: null,
  related_primary_display_field_id: DISPLAY_FIELD,
  custom_object_primary_display_field_id: DISPLAY_FIELD,
};

const visible = (id, conditions, fieldStates) => ({
  id,
  logic: 'and',
  rule_type: 'visibility',
  conditions,
  actions: [{ id: `${id}-action`, action_type: 'visibility', field_states: fieldStates }],
});
const condition = (field_id, operator, value) => ({ field_id, operator, value });

function juniorForm() {
  return {
    id: 'ebf2e9ae-92a2-4f1e-a91b-fb4f97ad277a',
    tenant_id: TENANT,
    fields: [
      { id: ids.country, type: 'country', required: true },
      {
        id: ids.trust,
        type: 'organisation_group_dropdown',
        options: [],
        required: true,
        conditional_filters: {
          version: 1,
          rules: [{
            id: 'conditional_filter_1789845775378_o5dvkf',
            source_field_id: '',
            operator: 'equals',
            value: '',
            is_fallback: true,
            allowed_values: [EXCLUDED_TRUST],
            allowed_values_mode: 'exclude',
            org_filter: null,
          }],
        },
      },
      { id: ids.worksAtSites, type: 'radio', starts_hidden: true },
      {
        id: ids.site,
        type: 'organisation_dropdown',
        options: [],
        starts_hidden: true,
        required: true,
        parent_field_id: ids.trust,
        parent_field_scope: 'form',
        organisation_group_parent_field_id: ids.trust,
        org_filter: {
          mode: 'include',
          type: 'custom',
          field: 'organisation_type',
          values: ['Hospital', 'NHS/HSC hospital or clinical site'],
        },
        conditional_filters: { version: 1, rules: [] },
      },
      {
        id: ids.department,
        type: 'relationship_dropdown',
        starts_hidden: true,
        required: false,
        parent_field_id: ids.site,
        parent_field_scope: 'form',
        ...relationshipMetadata,
      },
      { id: ids.hasOtherSites, type: 'radio', starts_hidden: true },
      {
        id: ids.rows,
        type: 'repeatable_rows',
        starts_hidden: true,
        required: false,
        initial_row_required: false,
        hide_when_first_column_empty: true,
        child_fields: [
          {
            id: ids.rowSite,
            type: 'organisation_dropdown',
            options: [],
            required: true,
            organisation_group_parent_scope: 'form',
            organisation_group_parent_field_id: ids.trust,
            exclude_values_from: { scope: 'form', source_field_id: ids.site },
          },
          {
            id: ids.rowDepartment,
            type: 'relationship_dropdown',
            required: true,
            parent_field_id: ids.rowSite,
            unique_across_rows: true,
            ...relationshipMetadata,
          },
        ],
      },
      { id: ids.memberClass, type: 'radio', starts_hidden: true },
    ],
    visibility_rules: [
      visible('show-role', [
        condition(ids.trust, 'not_equals', '__form_not_listed__'),
        condition(ids.trust, 'not_empty', ''),
      ], { [ids.worksAtSites]: { visible: true, enabled: null } }),
      visible('show-site', [
        condition(ids.worksAtSites, 'equals', 'Yes'),
      ], { [ids.site]: { visible: true, enabled: null } }),
      visible('show-department-and-other-question', [
        condition(ids.site, 'not_empty', ''),
        condition(ids.country, 'equals', 'United Kingdom'),
      ], {
        [ids.department]: { visible: true, enabled: null },
        [ids.hasOtherSites]: { visible: true, enabled: null },
      }),
      visible('show-other-rows', [
        condition(ids.hasOtherSites, 'equals', 'Yes'),
      ], { [ids.rows]: { visible: true, enabled: null } }),
      visible('hide-other-rows-for-trust-wide-role', [
        condition(ids.worksAtSites, 'equals', 'No, I have a trust-wide or organisation-wide role'),
      ], {
        [ids.hasOtherSites]: { visible: false, enabled: null },
        [ids.rows]: { visible: false, enabled: null },
      }),
      {
        id: 'rule_1788782516799',
        logic: 'and',
        rule_type: 'visibility',
        conditions: [condition(ids.memberClass, 'not_empty', '')],
        actions: [{
          id: 'action_membership_1788782532603',
          action_type: 'membership_structure',
          config_id: '',
          resolve_mode: 'auto',
          field_mappings: {
            '87f120ff-92e6-4d52-944b-9ba9d7b1fac0': ids.memberClass,
          },
        }],
      },
    ],
  };
}

function savedValues(overrides = {}) {
  return {
    [ids.country]: 'United Kingdom',
    [ids.trust]: TRUST,
    [ids.worksAtSites]: 'Yes',
    [ids.site]: SITE,
    // This is the actual saved hidden-initialized multi-select representation.
    [ids.department]: '',
    [ids.hasOtherSites]: 'No',
    [ids.memberClass]: 'Full junior',
    ...overrides,
  };
}

function baseSeed() {
  return {
    organization_group: [
      { id: TRUST, tenant_id: TENANT, name: 'Selected trust' },
      { id: EXCLUDED_TRUST, tenant_id: TENANT, name: 'Excluded trust' },
    ],
    organization: [
      { id: SITE, tenant_id: TENANT, organization_group_id: TRUST, name: 'Correct site' },
      { id: OTHER_SITE, tenant_id: TENANT, organization_group_id: 'another-trust', name: 'Other site' },
    ],
    custom_object_relationship_definition: [{
      id: DEFINITION,
      tenant_id: TENANT,
      status: 'active',
      archived_at: null,
      source_kind: 'custom_object',
      source_custom_object_id: OBJECT,
      target_kind: 'organization',
      target_custom_object_id: null,
      show_on_target: true,
    }],
    custom_object_definition: [{
      id: OBJECT,
      tenant_id: TENANT,
      status: 'active',
      archived_at: null,
      primary_display_field_id: DISPLAY_FIELD,
    }],
    preference_field: [{
      id: DISPLAY_FIELD,
      tenant_id: TENANT,
      custom_object_id: OBJECT,
      entity_scope: 'custom_object',
      is_active: true,
      name: 'department_name',
      field_type: 'text',
    }],
    custom_object_relationship: [
      {
        id: 'edge-1',
        tenant_id: TENANT,
        relationship_definition_id: DEFINITION,
        source_record_id: DEPARTMENT,
        target_record_id: SITE,
        archived_at: null,
      },
      {
        id: 'edge-2',
        tenant_id: TENANT,
        relationship_definition_id: DEFINITION,
        source_record_id: OTHER_DEPARTMENT,
        target_record_id: OTHER_SITE,
        archived_at: null,
      },
    ],
    custom_object_record: [
      { id: DEPARTMENT, tenant_id: TENANT, custom_object_id: OBJECT, archived_at: null },
      { id: OTHER_DEPARTMENT, tenant_id: TENANT, custom_object_id: OBJECT, archived_at: null },
    ],
  };
}

function mockDb(seed = baseSeed()) {
  const tables = structuredClone(seed);
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
    }
    select() { return this; }
    eq(column, value) {
      this.filters.push(row => String(row[column]) === String(value));
      return this;
    }
    is(column, value) {
      this.filters.push(row => (value === null ? row[column] == null : row[column] === value));
      return this;
    }
    in(column, values) {
      const allowed = new Set(values.map(String));
      this.filters.push(row => allowed.has(String(row[column])));
      return this;
    }
    order() { return this; }
    range(from, to) {
      const result = this.execute();
      return Promise.resolve({ ...result, data: result.data.slice(from, to + 1) });
    }
    execute() {
      return {
        data: (tables[this.table] || [])
          .filter(row => this.filters.every(filter => filter(row)))
          .map(row => structuredClone(row)),
        error: null,
      };
    }
    async maybeSingle() {
      const result = this.execute();
      return { ...result, data: result.data[0] || null };
    }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
  }
  return { from: table => new Query(table) };
}

function response() {
  return {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('conditional filter parity treats empty dynamic group options as an eligible universe', () => {
  for (const type of [
    'organisation_group_dropdown',
    'organisation_dropdown',
    'relationship_dropdown',
  ]) {
    const field = {
      type,
      options: [],
      conditional_filters: juniorForm().fields[1].conditional_filters,
    };
    const resolution = resolveConditionalFilter(field, {});
    assert.equal(resolution.allowedValues, null, type);
    assert.deepEqual(resolution.excludedValues, [EXCLUDED_TRUST], type);
    assert.equal(conditionalSelectionAllowed(TRUST, resolution), true, type);
    assert.equal(conditionalSelectionAllowed(EXCLUDED_TRUST, resolution), false, type);
  }
});

test('conditional filter parity keeps an ordinary empty static options list authoritative', () => {
  const resolution = resolveConditionalFilter({
    type: 'dropdown',
    options: [],
    conditional_filters: juniorForm().fields[1].conditional_filters,
  }, {});
  assert.deepEqual(resolution.allowedValues, []);
  assert.equal(conditionalSelectionAllowed(TRUST, resolution), false);
});

test('BNMS junior v2 payment accepts the correct site and both blank optional multi department shapes', async () => {
  for (const department of ['', []]) {
    const res = response();
    assert.equal(await validatePaymentRelationships(
      res,
      mockDb(),
      { id: TENANT },
      juniorForm(),
      savedValues({ [ids.department]: department }),
    ), true, JSON.stringify(department));
    assert.equal(res.statusCode, null);
  }
});

test('BNMS junior v2 quote key supersedes failed site, department, and No-visibility answers with unchanged membership mappings', () => {
  const form = juniorForm();
  const captured = savedValues({ [ids.department]: [] });
  const match = resolveMembershipMatch(form, captured);
  assert.ok(match);

  const correctedSite = membershipQuoteKey(match, captured, form);
  const correctedDepartment = membershipQuoteKey(match, captured, form);
  const correctedNo = membershipQuoteKey(match, captured, form);
  const failedSite = membershipQuoteKey(match, {
    ...captured,
    [ids.site]: OTHER_SITE,
  }, form);
  const failedDepartment = membershipQuoteKey(match, {
    ...captured,
    [ids.department]: DEPARTMENT,
  }, form);
  const beforeNoHidesRows = membershipQuoteKey(match, {
    ...captured,
    [ids.hasOtherSites]: 'Yes',
    [ids.rows]: [{
      _row_id: 'invalid-visible-row',
      [ids.rowSite]: 'forged-site',
      [ids.rowDepartment]: ['forged-department'],
    }],
  }, form);

  assert.notEqual(failedSite, correctedSite, 'correcting the primary site must request a fresh quote');
  assert.notEqual(failedDepartment, correctedDepartment,
    'normalizing a multi department scalar to [] must request a fresh quote');
  assert.notEqual(beforeNoHidesRows, correctedNo,
    'choosing No and hiding invalid additional rows must request a fresh quote');

  const mapped = key => JSON.parse(key).vals;
  assert.deepEqual(mapped(failedSite), mapped(correctedSite));
  assert.deepEqual(mapped(failedDepartment), mapped(correctedDepartment));
  assert.deepEqual(mapped(beforeNoHidesRows), mapped(correctedNo));
  assert.deepEqual(mapped(correctedNo), { [ids.memberClass]: 'Full junior' });
});

test('BNMS junior v2 payment rejects trust exclusion and a site outside the selected trust', async () => {
  for (const values of [
    savedValues({ [ids.trust]: EXCLUDED_TRUST }),
    savedValues({ [ids.site]: OTHER_SITE }),
  ]) {
    const res = response();
    assert.equal(await validatePaymentRelationships(
      res, mockDb(), { id: TENANT }, juniorForm(), values,
    ), false);
    assert.equal(res.statusCode, 400);
  }
});

test('BNMS junior v2 payment ignores stale forged rows when No keeps additional rows hidden', async () => {
  const res = response();
  const values = savedValues({
    [ids.rows]: [{
      _row_id: 'stale-hidden-row',
      [ids.rowSite]: 'forged-site',
      [ids.rowDepartment]: ['forged-department'],
    }],
  });
  assert.equal(await validatePaymentRelationships(
    res, mockDb(), { id: TENANT }, juniorForm(), values,
  ), true);
  assert.equal(res.statusCode, null);
});

test('BNMS junior v2 service rejects a nonempty scalar for the multi department', async () => {
  const service = createFormRelationshipService({ db: mockDb(), tenantId: TENANT });
  await assert.rejects(
    service.validateSubmission({
      form: juniorForm(),
      submissionData: savedValues({ [ids.department]: DEPARTMENT }),
      hiddenFieldIds: new Set([ids.rows]),
    }),
    error => error instanceof FormRelationshipError
      && error.status === 400 && /selection mode/.test(error.message),
  );
});

test('BNMS junior v2 service rejects forged, wrong-parent, archived, and cross-tenant departments', async () => {
  const cases = [
    ['forged', 'forged-department', seed => seed],
    ['wrong parent', OTHER_DEPARTMENT, seed => seed],
    ['archived edge', DEPARTMENT, seed => {
      seed.custom_object_relationship[0].archived_at = '2025-01-01';
      return seed;
    }],
    ['archived record', DEPARTMENT, seed => {
      seed.custom_object_record[0].archived_at = '2025-01-01';
      return seed;
    }],
    ['cross tenant record', DEPARTMENT, seed => {
      seed.custom_object_record[0].tenant_id = 'another-tenant';
      return seed;
    }],
  ];
  for (const [label, selected, alter] of cases) {
    const service = createFormRelationshipService({
      db: mockDb(alter(baseSeed())),
      tenantId: TENANT,
    });
    await assert.rejects(
      service.validateSubmission({
        form: juniorForm(),
        submissionData: savedValues({ [ids.department]: [selected] }),
        hiddenFieldIds: new Set([ids.rows]),
      }),
      error => error instanceof FormRelationshipError
        && error.status === 400 && /Invalid relationship selection/.test(error.message),
      label,
    );
  }
});