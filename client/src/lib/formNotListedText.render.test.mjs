import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_TEXT_MAX_LENGTH,
  FORM_NOT_LISTED_VALUE,
  pruneFormNotListedText,
  setFormNotListedText,
  setRepeatableRowNotListedText,
} from '../../../shared/formNotListedChoice.js';

const renderer = readFileSync(
  new URL('../components/forms/FormRenderer.jsx', import.meta.url),
  'utf8',
);
const formView = readFileSync(new URL('../pages/FormView.jsx', import.meta.url), 'utf8');
const embedForm = readFileSync(new URL('../pages/EmbedForm.jsx', import.meta.url), 'utf8');
const reviewSubmission = readFileSync(new URL('../pages/ReviewSubmission.jsx', import.meta.url), 'utf8');
const singleFieldEdit = readFileSync(new URL('../components/SingleFieldEditModal.jsx', import.meta.url), 'utf8');
const formSubmissionView = readFileSync(new URL('../pages/FormSubmissionView.jsx', import.meta.url), 'utf8');
const formSubmissions = readFileSync(new URL('../pages/FormSubmissions.jsx', import.meta.url), 'utf8');
const wordExport = readFileSync(new URL('./formSubmissionWordExport.js', import.meta.url), 'utf8');

test('not-listed text helpers retain only populated field text maps', () => {
  const root = setFormNotListedText({}, 'country', 'Atlantis');
  assert.deepEqual(root, { [FORM_NOT_LISTED_TEXT_KEY]: { country: 'Atlantis' } });
  assert.deepEqual(setFormNotListedText(root, 'country', ''), {});

  const row = setRepeatableRowNotListedText(
    { _row_id: 'row-1', country: FORM_NOT_LISTED_VALUE },
    'country',
    'Atlantis',
  );
  assert.deepEqual(row, {
    _row_id: 'row-1',
    country: FORM_NOT_LISTED_VALUE,
    [FORM_NOT_LISTED_TEXT_KEY]: { country: 'Atlantis' },
  });
  const siblingText = setRepeatableRowNotListedText(row, 'department', 'Specialist team');
  assert.deepEqual(siblingText[FORM_NOT_LISTED_TEXT_KEY], {
    country: 'Atlantis',
    department: 'Specialist team',
  });
  assert.deepEqual(
    setRepeatableRowNotListedText(siblingText, 'department', '')[FORM_NOT_LISTED_TEXT_KEY],
    { country: 'Atlantis' },
  );
  assert.deepEqual(pruneFormNotListedText([
    { id: 'country', type: 'country' },
  ], {
    country: 'Spain',
    [FORM_NOT_LISTED_TEXT_KEY]: { country: 'stale text' },
  }), { country: 'Spain' });
});

test('renderer supplies the required accessible not-listed text control and validity', () => {
  assert.match(renderer, /containsFormNotListedValue\(value\)/);
  assert.match(renderer, /<Label htmlFor=\{`\$\{field\.id\}-not-listed-text`\}>Please specify<\/Label>/);
  assert.match(renderer, /required/);
  assert.match(renderer, /maxLength=\{FORM_NOT_LISTED_TEXT_MAX_LENGTH\}/);
  assert.match(renderer, /aria-invalid=\{invalid\}/);
  assert.match(renderer, /Boolean\(notListedText\.trim\(\)\)[\s\S]*FORM_NOT_LISTED_TEXT_MAX_LENGTH/);
  assert.match(renderer, /if \(hasStoredNotListedText\) onFormNotListedTextChange\?\.\(''\)/);
});

test('root, repeatable, and review editors persist not-listed text through their contracts', () => {
  assert.match(formView, /setFormValues\(prev => setFormNotListedText\(prev, fieldId, text\)\)/);
  assert.match(embedForm, /setFormValues\(prev => setFormNotListedText\(prev, fieldId, text\)\)/);
  assert.match(renderer, /setRepeatableRowNotListedText\(current, childId, text\)/);
  assert.match(renderer, /current\._row_id === rowId/);
  assert.match(renderer, /pendingRows\.current = nextRows/);
  assert.match(renderer, /reconcilePendingRepeatableRows\(incomingRows, pendingRows\.current\)/);
  assert.match(renderer, /const rows = reconciledRows\.currentRows/);
  assert.match(renderer, /resolveRelationshipParentTransition/);
  assert.match(renderer, /shouldClearFilteredOrganisationValue\(\{[\s\S]*optionsLoaded: !orgsLoading/);
  assert.match(renderer, /!containsFormNotListedValue\(nextValue\)[\s\S]*setRepeatableRowNotListedText\(updated, childId, ''\)/);
  assert.match(reviewSubmission, /setReviewedFormValues\(prev => setFormNotListedText\(prev, fieldId, text\)\)/);
  assert.match(reviewSubmission, /values\[FORM_NOT_LISTED_TEXT_KEY\] =/);
  assert.match(reviewSubmission, /return pruneFormNotListedText\(fields, values\)/);
  assert.match(formView, /pruneFormNotListedText\(form\.fields, Object\.fromEntries/);
  assert.match(embedForm, /pruneFormNotListedText\(form\.fields, Object\.fromEntries/);
  assert.match(singleFieldEdit, /currentNotListedText/);
  assert.match(singleFieldEdit, /not_listed_text: notListedText/);
  assert.match(singleFieldEdit, /data-testid="input-edit-not-listed-text"/);
  assert.match(singleFieldEdit, /Please specify the not-listed value/);
});

test('submission screens and exports hide reserved text metadata while passing it to formatters', () => {
  for (const source of [formSubmissionView, formSubmissions, wordExport]) {
    assert.match(source, /FORM_NOT_LISTED_TEXT_KEY/);
  }
  assert.match(formSubmissionView, /submissionData=\{submissionData\}/);
  assert.match(formSubmissions, /submissionData=\{viewingSubmission\.submission_data\}/);
});