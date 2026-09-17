import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterAutoHiddenRepeatableSubmissionData,
  resolveAutoHiddenRepeatableContainerIds,
  resolveSubmissionEmailFieldDisplayValue,
} from './formSubmissionEmails.js';
import { FORM_NOT_LISTED_VALUE } from '../../shared/formNotListedChoice.js';

const currentId = '11111111-1111-4111-8111-111111111111';
const missingId = '22222222-2222-4222-8222-222222222222';
const fields = [
  { id: 'relationship-id', name: 'Current relationship', type: 'relationship_dropdown' },
  { id: 'legacy-relationship', name: 'Legacy relationship', type: 'relationship_dropdown' },
];

function display(fieldKey, persistedSubmissionData, labels) {
  return resolveSubmissionEmailFieldDisplayValue({
    fields,
    fieldKey,
    rawValue: missingId,
    persistedSubmissionData,
    relationshipLabelsByRecordId: labels,
  });
}

test('configured form-email placeholders render current and missing ID-keyed relationship labels safely', () => {
  assert.equal(
    display('relationship-id', { 'relationship-id': currentId }, { [currentId]: 'Current record' }),
    'Current record',
  );
  assert.equal(
    display('relationship-id', { 'relationship-id': missingId }, {}),
    'Unavailable record',
  );
});


test('configured form-email placeholders render current and missing legacy name-keyed relationship labels safely', () => {
  assert.equal(
    display('legacy-relationship', { 'Legacy relationship': currentId }, { [currentId]: 'Legacy record' }),
    'Legacy record',
  );
  const output = display('Legacy relationship', { 'Legacy relationship': missingId }, {});
  assert.equal(output, 'Unavailable record');
  assert.equal(output.includes(missingId), false);
});

test('configured form-email placeholders render snapshotted not-listed labels', () => {
  const notListedField = {
    id: 'org',
    name: 'Organisation',
    type: 'organisation_dropdown',
    not_listed_choice: { enabled: false, label: 'Renamed label' },
  };
  assert.equal(resolveSubmissionEmailFieldDisplayValue({
    fields: [notListedField],
    fieldKey: 'org',
    rawValue: '__form_not_listed__',
    persistedSubmissionData: {
      org: '__form_not_listed__',
      __not_listed_choice_labels: { org: 'Original label' },
      __not_listed_choice_text: { org: 'Independent organisation' },
    },
    relationshipLabelsByRecordId: {},
  }), 'Original label — Independent organisation');
});

test('configured form-email placeholders resolve real relationships alongside inclusive Other text', () => {
  const field = {
    id: 'department',
    type: 'relationship_dropdown',
    selection_mode: 'multiple',
    not_listed_choice: { enabled: true, label: 'Other department' },
  };
  assert.equal(resolveSubmissionEmailFieldDisplayValue({
    fields: [field],
    fieldKey: field.id,
    rawValue: [],
    persistedSubmissionData: {
      department: ['record-1', '__form_not_listed__'],
      __not_listed_choice_text: { department: 'Research partnerships' },
    },
    relationshipLabelsByRecordId: { 'record-1': 'Finance' },
  }), 'Finance, Other department — Research partnerships');
});

test('configured form-email placeholders render repeatable rows and nested relationship labels', () => {
  const repeatable = {
    id: 'contacts',
    type: 'repeatable_row',
    repeatable_row: {
      child_fields: [
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'employer', label: 'Employer', type: 'organisation_dropdown' },
        { id: 'organisation', label: 'Organisation', type: 'relationship_dropdown' },
      ],
    },
  };
  const output = resolveSubmissionEmailFieldDisplayValue({
    fields: [repeatable],
    fieldKey: 'contacts',
    rawValue: [],
    persistedSubmissionData: {
      contacts: [{ _row_id: 'private-row-id', name: 'Grace', employer: 'org-1', organisation: currentId }],
    },
    relationshipLabelsByRecordId: { [currentId]: 'Computing Society' },
    organisationNamesById: { 'org-1': 'Ada Systems' },
  });
  assert.equal(output, 'Row 1\nName: Grace\nEmployer: Ada Systems\nOrganisation: Computing Society');
  assert.equal(output.includes(currentId), false);
  assert.equal(output.includes('private-row-id'), false);
  assert.equal(output.includes('org-1'), false);
});

test('configured form-email placeholders preserve partial repeatable dates verbatim', () => {
  const repeatable = {
    id: 'periods',
    type: 'repeatable_row',
    children: [
      { id: 'month', label: 'Month', type: 'date', date_precision: 'month' },
      { id: 'year', label: 'Year', type: 'date', date_precision: 'year' },
    ],
  };
  assert.equal(resolveSubmissionEmailFieldDisplayValue({
    fields: [repeatable],
    fieldKey: 'periods',
    rawValue: [],
    persistedSubmissionData: {
      periods: [{ month: '2026-03', year: '2026' }],
    },
    relationshipLabelsByRecordId: {},
  }), 'Row 1\nMonth: 2026-03\nYear: 2026');
});

test('configured form-email placeholders retain repeatable not-listed labels', () => {
  const repeatable = {
    id: 'contacts',
    type: 'repeatable_row',
    children: [{
      id: 'employer',
      label: 'Employer',
      type: 'organisation_dropdown',
      not_listed_choice: { enabled: false, label: 'Renamed label' },
    }],
  };
  assert.equal(resolveSubmissionEmailFieldDisplayValue({
    fields: [repeatable],
    fieldKey: 'contacts',
    rawValue: [],
    persistedSubmissionData: {
      contacts: [{
        employer: '__form_not_listed__',
        __not_listed_choice_text: { employer: 'Independent organisation' },
      }],
      __not_listed_choice_labels: { contacts: { employer: 'Original employer label' } },
    },
    relationshipLabelsByRecordId: {},
    organisationNamesById: {},
  }), 'Row 1\nEmployer: Original employer label — Independent organisation');
});

test('configured form-email placeholders resolve repeatable real relationships with inclusive Other', () => {
  const repeatable = {
    id: 'contacts',
    type: 'repeatable_row',
    children: [{
      id: 'department',
      label: 'Department',
      type: 'relationship_dropdown',
      selection_mode: 'multiple',
      not_listed_choice: { enabled: true, label: 'Other department' },
    }],
  };
  assert.equal(resolveSubmissionEmailFieldDisplayValue({
    fields: [repeatable],
    fieldKey: 'contacts',
    rawValue: [],
    persistedSubmissionData: {
      contacts: [{
        department: ['record-1', '__form_not_listed__'],
        __not_listed_choice_text: { department: 'Research partnerships' },
      }],
    },
    relationshipLabelsByRecordId: { 'record-1': 'Finance' },
  }), 'Row 1\nDepartment: Finance, Other department — Research partnerships');
});

test('submission email side effects omit only auto-hidden repeatable answers without mutating raw data', () => {
  const repeatable = {
    id: 'contacts',
    name: 'Contacts',
    type: 'repeatable_row',
    hide_when_first_column_empty: true,
    children: [
      { id: 'employer', name: 'Employer', type: 'organisation_dropdown' },
      { id: 'note', type: 'text' },
    ],
  };
  const raw = {
    contacts: [{ _row_id: 'retained-row', employer: 'org-1', note: 'retained answer' }],
    visible_answer: 'keep this',
    employer: 'top-level child answer',
  };
  const sideEffectData = filterAutoHiddenRepeatableSubmissionData({
    form: { fields: [repeatable] },
    formValues: raw,
    containerIds: new Set(['contacts']),
  });

  assert.deepEqual(raw, {
    contacts: [{ _row_id: 'retained-row', employer: 'org-1', note: 'retained answer' }],
    visible_answer: 'keep this',
    employer: 'top-level child answer',
  });
  assert.deepEqual(sideEffectData, { visible_answer: 'keep this' });
});

test('ordinary hidden repeatable answers stay available to existing email behavior', () => {
  const repeatable = {
    id: 'contacts',
    type: 'repeatable_row',
    children: [{ id: 'note', type: 'text' }],
  };
  const raw = {
    contacts: [{ note: 'ordinary hidden answer' }],
    visible_answer: 'keep this',
  };
  assert.strictEqual(
    filterAutoHiddenRepeatableSubmissionData({
      form: { fields: [repeatable] },
      formValues: raw,
      containerIds: new Set(),
    }),
    raw,
  );
});

function organisationAvailabilityDb(organisations) {
  return {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) {
          filters.push([column, value]);
          return query;
        },
        order() {
          const data = table === 'organization'
            ? organisations.filter(row => filters.every(([column, value]) => (
              String(row[column]) === String(value)
            )))
            : [];
          return Promise.resolve({ data, error: null });
        },
      };
      return query;
    },
  };
}

test('email side-effect visibility uses authoritative auto-empty availability', async () => {
  const repeatable = {
    id: 'additional-organisations',
    type: 'repeatable_rows',
    hide_when_first_column_empty: true,
    children: [{
      id: 'organisation',
      type: 'organisation_dropdown',
    }],
  };
  const form = { id: 'form-1', fields: [repeatable] };
  const containerIds = await resolveAutoHiddenRepeatableContainerIds({
    db: organisationAvailabilityDb([]),
    tenantId: 'tenant-1',
    form,
    formValues: {
      'additional-organisations': [{ organisation: 'retained-org' }],
    },
  });
  assert.deepEqual([...containerIds], ['additional-organisations']);

  const availableIds = await resolveAutoHiddenRepeatableContainerIds({
    db: organisationAvailabilityDb([{ id: 'org-1', tenant_id: 'tenant-1' }]),
    tenantId: 'tenant-1',
    form,
    formValues: {},
  });
  assert.deepEqual([...availableIds], []);
});

test('email side effects suppress conditional Not listed empty repeatables', async () => {
  for (const conditional of [
    { mode: 'include', allowed_values: ['available-org'] },
    { mode: 'exclude', allowed_values: [FORM_NOT_LISTED_VALUE] },
  ]) {
    const repeatable = {
      id: 'additional-organisations',
      type: 'repeatable_rows',
      hide_when_first_column_empty: true,
      children: [{
        id: 'organisation',
        type: 'organisation_dropdown',
        not_listed_choice: { enabled: true, label: 'Other' },
        conditional_filters: {
          version: 1,
          rules: [{
            id: `conditional-${conditional.mode}`,
            source_field_id: 'country',
            operator: 'equals',
            value: 'GB',
            is_fallback: false,
            allowed_values: conditional.allowed_values,
            allowed_values_mode: conditional.mode,
            org_filter: null,
          }],
        },
      }, {
        id: 'notes',
        type: 'text',
      }],
    };
    const form = {
      id: `form-conditional-${conditional.mode}`,
      fields: [{ id: 'country', type: 'dropdown' }, repeatable],
    };
    const formValues = {
      country: 'GB',
      'additional-organisations': [{
        organisation: FORM_NOT_LISTED_VALUE,
        notes: 'retained stale answer',
      }],
    };
    const containerIds = await resolveAutoHiddenRepeatableContainerIds({
      db: organisationAvailabilityDb([]),
      tenantId: 'tenant-1',
      form,
      formValues,
    });
    assert.deepEqual([...containerIds], ['additional-organisations'], conditional.mode);
    assert.deepEqual(
      filterAutoHiddenRepeatableSubmissionData({
        form,
        formValues,
        containerIds,
      }),
      { country: 'GB' },
      conditional.mode,
    );
  }
});