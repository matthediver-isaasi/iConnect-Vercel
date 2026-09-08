import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_VALUE,
} from '../../../shared/formNotListedChoice.js';
import { prepareFormSubmissionValues } from './formSubmissionPayload.js';

const ORGANISATION_FIELD_ID = 'field_1787065791684';
const fields = [
  { id: 'intro', type: 'instructions' },
  {
    id: ORGANISATION_FIELD_ID,
    type: 'organisation_dropdown',
    not_listed_choice: { enabled: true, label: 'Not listed' },
  },
];

test('FormView builds submission_data with the tested payload helper', async () => {
  const source = await readFile(new URL('../pages/FormView.jsx', import.meta.url), 'utf8');
  assert.match(source, /prepareFormSubmissionValues\(form\.fields, formValues\)/);
  assert.match(source, /submission_data:\s*\{\s*\.\.\.filteredFormValues,/);
});

test('FormView payload keeps the affected not-listed sentinel and companion text under the same field id', () => {
  const result = prepareFormSubmissionValues(fields, {
    intro: 'display-only',
    [ORGANISATION_FIELD_ID]: FORM_NOT_LISTED_VALUE,
    [FORM_NOT_LISTED_TEXT_KEY]: {
      [ORGANISATION_FIELD_ID]: 'Runtime University',
    },
  });

  assert.equal(result.intro, undefined);
  assert.equal(result[ORGANISATION_FIELD_ID], FORM_NOT_LISTED_VALUE);
  assert.equal(
    result[FORM_NOT_LISTED_TEXT_KEY][ORGANISATION_FIELD_ID],
    'Runtime University',
  );
});

test('FormView payload keeps a listed organisation id and removes stale companion text', () => {
  const organizationId = '7dc51049-90dc-42cf-9567-2b128321c21c';
  const result = prepareFormSubmissionValues(fields, {
    [ORGANISATION_FIELD_ID]: organizationId,
    [FORM_NOT_LISTED_TEXT_KEY]: {
      [ORGANISATION_FIELD_ID]: 'Must not become the organisation name',
    },
  });

  assert.equal(result[ORGANISATION_FIELD_ID], organizationId);
  assert.equal(result[FORM_NOT_LISTED_TEXT_KEY], undefined);
});

test('FormView payload preserves whitespace-only companion text for authoritative validation', () => {
  const result = prepareFormSubmissionValues(fields, {
    [ORGANISATION_FIELD_ID]: FORM_NOT_LISTED_VALUE,
    [FORM_NOT_LISTED_TEXT_KEY]: {
      [ORGANISATION_FIELD_ID]: '   ',
    },
  });

  assert.equal(result[FORM_NOT_LISTED_TEXT_KEY][ORGANISATION_FIELD_ID], '   ');
});