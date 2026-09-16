import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAuthoritativeHiddenFieldIds,
  resolveRepeatableFirstColumnAvailability,
} from './formFieldVisibility.js';
import { validateRepeatableRowSubmission } from './formRepeatableRowValidation.js';

function fakeDb({
  organizations = [],
  groups = [],
  failOrganizations = false,
  supportRange = false,
} = {}) {
  return {
    from(table) {
      const rows = table === 'organization' ? organizations : groups;
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        order() {
          if (failOrganizations && table === 'organization') {
            return Promise.resolve({ data: null, error: new Error('organisation lookup failed') });
          }
          if (supportRange && table === 'organization') return query;
          return Promise.resolve({
            data: rows.filter(row => filters.every(([column, value]) => (
              String(row?.[column]) === String(value)
            ))),
            error: null,
          });
        },
        range(start, end) {
          if (!supportRange || table !== 'organization') return query;
          if (failOrganizations) {
            return Promise.resolve({ data: null, error: new Error('organisation lookup failed') });
          }
          const selected = rows.filter(row => filters.every(([column, value]) => (
            String(row?.[column]) === String(value)
          )));
          return Promise.resolve({ data: selected.slice(start, end + 1), error: null });
        },
        maybeSingle() {
          const row = rows.find(candidate => filters.every(([column, value]) => (
            String(candidate?.[column]) === String(value)
          )));
          return Promise.resolve({ data: row || null, error: null });
        },
      };
      return query;
    },
  };
}

function reportedForm({ notListed = false } = {}) {
  return {
    id: 'reported-form',
    fields: [
      { id: 'trust-group', type: 'organisation_group_dropdown' },
      { id: 'primary-organisation', type: 'organisation_dropdown' },
      {
        id: 'additional-organisations',
        type: 'repeatable_rows',
        hide_when_first_column_empty: true,
        children: [{
          id: 'organisation',
          type: 'organisation_dropdown',
          organisation_group_parent_field_id: 'trust-group',
          organisation_group_parent_scope: 'form',
          exclude_values_from: {
            scope: 'form',
            source_field_id: 'primary-organisation',
          },
          ...(notListed ? { not_listed_choice: { enabled: true, label: 'Other' } } : {}),
        }, {
          id: 'notes',
          type: 'text',
        }],
      },
    ],
  };
}

const organizations = [
  { id: 'primary', tenant_id: 'tenant', organization_group_id: 'trust-group' },
  { id: 'alternative', tenant_id: 'tenant', organization_group_id: 'trust-group' },
  { id: 'other-group', tenant_id: 'tenant', organization_group_id: 'other-group' },
];
const groups = [
  { id: 'trust-group', tenant_id: 'tenant' },
  { id: 'other-group', tenant_id: 'tenant' },
];

function conditionalNotListedForm({
  allowedValues,
  mode = 'include',
  fallback = false,
}) {
  const form = reportedForm({ notListed: true });
  form.fields.splice(2, 0, { id: 'country', type: 'dropdown' });
  form.fields[3].children[0].conditional_filters = {
    version: 1,
    rules: [{
      id: `conditional-${mode}`,
      source_field_id: 'country',
      operator: 'equals',
      value: 'GB',
      is_fallback: fallback,
      allowed_values: allowedValues,
      allowed_values_mode: mode,
      org_filter: null,
    }],
  };
  return form;
}

test('authoritative repeatable availability applies group scope and earlier-answer exclusion', async () => {
  const form = reportedForm();
  const db = fakeDb({ organizations: organizations.slice(0, 2), groups });
  const values = { 'trust-group': 'trust-group', 'primary-organisation': 'primary' };
  const availability = await resolveRepeatableFirstColumnAvailability({
    db, tenantId: 'tenant', form, field: form.fields[2], formValues: values,
  });
  assert.equal(availability.status, 'available');

  const hidden = await computeAuthoritativeHiddenFieldIds({
    db, tenantId: 'tenant', form, formValues: values,
  });
  assert.ok(!hidden.has('additional-organisations'));

  const onlyPrimary = fakeDb({
    organizations: [organizations[0]],
    groups,
  });
  const emptyHidden = await computeAuthoritativeHiddenFieldIds({
    db: onlyPrimary, tenantId: 'tenant', form, formValues: values,
  });
  assert.ok(emptyHidden.has('additional-organisations'));
  assert.ok(emptyHidden.has('organisation'));
  assert.ok(emptyHidden.has('notes'));
});

test('missing prerequisites and lookup failures fail open', async () => {
  const form = reportedForm();
  const missingGroup = await computeAuthoritativeHiddenFieldIds({
    db: fakeDb({ organizations: [], groups }),
    tenantId: 'tenant',
    form,
    formValues: { 'primary-organisation': 'primary' },
  });
  assert.ok(!missingGroup.has('additional-organisations'));

  const failedLookup = await computeAuthoritativeHiddenFieldIds({
    db: fakeDb({ organizations: [], groups, failOrganizations: true }),
    tenantId: 'tenant',
    form,
    formValues: { 'trust-group': 'trust-group', 'primary-organisation': 'primary' },
  });
  assert.ok(!failedLookup.has('additional-organisations'));
});

test('enabled Not listed fallback prevents confirmed-empty hiding', async () => {
  const form = reportedForm({ notListed: true });
  const hidden = await computeAuthoritativeHiddenFieldIds({
    db: fakeDb({ organizations: [], groups }),
    tenantId: 'tenant',
    form,
    formValues: { 'trust-group': 'trust-group', 'primary-organisation': 'primary' },
  });
  assert.ok(!hidden.has('additional-organisations'));

  const excludedNotListed = await computeAuthoritativeHiddenFieldIds({
    db: fakeDb({ organizations: [], groups }),
    tenantId: 'tenant',
    form,
    formValues: {
      'trust-group': 'trust-group',
      'primary-organisation': '__form_not_listed__',
    },
  });
  assert.ok(excludedNotListed.has('additional-organisations'));
  assert.ok(excludedNotListed.has('organisation'));
  assert.ok(excludedNotListed.has('notes'));
});

test('Not listed follows every conditional target mode before empty hiding', async () => {
  const cases = [
    { name: 'include omits the sentinel', mode: 'include', allowedValues: ['available-org'], empty: true },
    { name: 'exclude removes the sentinel', mode: 'exclude', allowedValues: ['__form_not_listed__'], empty: true },
    { name: 'include keeps the sentinel when listed', mode: 'include', allowedValues: ['__form_not_listed__'], empty: false },
    { name: 'exclude keeps the sentinel when another value is excluded', mode: 'exclude', allowedValues: ['blocked-org'], empty: false },
    { name: 'include empty is unrestricted', mode: 'include', allowedValues: [], empty: false },
    { name: 'exclude empty is unrestricted', mode: 'exclude', allowedValues: [], empty: false },
    { name: 'include fallback omits the sentinel', mode: 'include', allowedValues: ['available-org'], fallback: true, empty: true },
    { name: 'exclude fallback removes the sentinel', mode: 'exclude', allowedValues: ['__form_not_listed__'], fallback: true, empty: true },
    { name: 'include fallback keeps the sentinel when listed', mode: 'include', allowedValues: ['__form_not_listed__'], fallback: true, empty: false },
    { name: 'exclude fallback keeps the sentinel when another value is excluded', mode: 'exclude', allowedValues: ['blocked-org'], fallback: true, empty: false },
    { name: 'include fallback empty is unrestricted', mode: 'include', allowedValues: [], fallback: true, empty: false },
    { name: 'exclude fallback empty is unrestricted', mode: 'exclude', allowedValues: [], fallback: true, empty: false },
  ];

  for (const current of cases) {
    const form = conditionalNotListedForm(current);
    const values = {
      country: 'GB',
      'trust-group': 'trust-group',
      'primary-organisation': 'primary',
      'additional-organisations': [{ organisation: 'retained-stale-answer' }],
    };
    const availability = await resolveRepeatableFirstColumnAvailability({
      db: fakeDb({ organizations: [], groups }),
      tenantId: 'tenant',
      form,
      field: form.fields[3],
      formValues: values,
    });
    assert.equal(availability.status, current.empty ? 'empty' : 'available', current.name);

    const hidden = await computeAuthoritativeHiddenFieldIds({
      db: fakeDb({ organizations: [], groups }),
      tenantId: 'tenant',
      form,
      formValues: values,
    });
    assert.equal(hidden.has('additional-organisations'), current.empty, current.name);
    assert.equal(hidden.has('organisation'), current.empty, current.name);
    if (current.empty) {
      await assert.doesNotReject(() => validateRepeatableRowSubmission({
        db: fakeDb({ organizations: [], groups }),
        tenantId: 'tenant',
        form,
        submissionData: values,
        hiddenFieldIds: hidden,
      }), current.name);
    }
  }
});

test('answered conditional source with no matching valid rule confirms empty availability', async () => {
  const form = reportedForm();
  form.fields.splice(2, 0, { id: 'country', type: 'dropdown' });
  form.fields[3].children[0].conditional_filters = {
    version: 1,
    rules: [{
      id: 'gb-only',
      source_field_id: 'country',
      operator: 'equals',
      value: 'GB',
      is_fallback: false,
      allowed_values: [],
      org_filter: null,
    }],
  };
  const db = fakeDb({ organizations, groups });
  const submissionData = {
    country: 'US',
    'trust-group': 'trust-group',
    'primary-organisation': 'primary',
    'additional-organisations': [{ organisation: 'retained-stale-answer' }],
  };
  const hidden = await computeAuthoritativeHiddenFieldIds({
    db,
    tenantId: 'tenant',
    form,
    formValues: submissionData,
  });
  assert.ok(hidden.has('additional-organisations'));
  assert.ok(hidden.has('organisation'));
  assert.ok(hidden.has('notes'));
  await assert.doesNotReject(() => validateRepeatableRowSubmission({
    db,
    tenantId: 'tenant',
    form,
    submissionData,
    hiddenFieldIds: hidden,
  }));
});

test('unsupported persisted filters fail open instead of becoming empty', async () => {
  const form = reportedForm();
  form.fields[2].children[0].org_filter = { type: 'forged', field: 'status', values: [] };
  const availability = await resolveRepeatableFirstColumnAvailability({
    db: fakeDb({ organizations: [], groups }),
    tenantId: 'tenant',
    form,
    field: form.fields[2],
    formValues: { 'trust-group': 'trust-group', 'primary-organisation': 'primary' },
  });
  assert.equal(availability.status, 'unresolved');
  const hidden = await computeAuthoritativeHiddenFieldIds({
    db: fakeDb({ organizations: [], groups }),
    tenantId: 'tenant',
    form,
    formValues: { 'trust-group': 'trust-group', 'primary-organisation': 'primary' },
  });
  assert.ok(!hidden.has('additional-organisations'));
});

test('availability scans beyond the database first page before confirming empty', async () => {
  const form = reportedForm();
  const firstPage = Array.from({ length: 500 }, (_, index) => ({
    id: `other-${index}`,
    tenant_id: 'tenant',
    organization_group_id: 'other-group',
  }));
  const db = fakeDb({
    organizations: [...firstPage, organizations[1]],
    groups,
    supportRange: true,
  });
  const hidden = await computeAuthoritativeHiddenFieldIds({
    db,
    tenantId: 'tenant',
    form,
    formValues: { 'trust-group': 'trust-group', 'primary-organisation': 'primary' },
  });
  assert.ok(!hidden.has('additional-organisations'));
});

test('authoritatively hidden retained rows do not trigger repeatable validation', async () => {
  const form = reportedForm();
  await assert.doesNotReject(() => validateRepeatableRowSubmission({
    db: fakeDb({ organizations: [organizations[0]], groups }),
    tenantId: 'tenant',
    form,
    submissionData: {
      'trust-group': 'trust-group',
      'primary-organisation': 'primary',
      'additional-organisations': [{ organisation: 'forged', unexpected: true }],
    },
  }));
});