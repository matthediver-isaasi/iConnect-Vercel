import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import moment from 'moment';
import { matchSubmissionSearch, submissionSearchAnswers } from './formSubmissionSearch.js';
import { FORM_NOT_LISTED_VALUE } from '../../../shared/formNotListedChoice.js';

const formSubmissionsSource = readFileSync(
  new URL('../pages/FormSubmissions.jsx', import.meta.url),
  'utf8',
);

const filteredSubmissionsCallback = formSubmissionsSource.match(
  /const filteredSubmissions = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[scopedSubmissions, selectedForm, assignmentFilter, selectedStatus, dateFrom, dateTo, searchQuery, submissionSearchMatches\]\);/,
)?.[1];
const paginatedSubmissionsCallback = formSubmissionsSource.match(
  /const paginatedSubmissions = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[filteredSubmissions, currentPage, itemsPerPage\]\);/,
)?.[1];
assert.ok(filteredSubmissionsCallback, 'could not extract page filteredSubmissions callback');
assert.ok(paginatedSubmissionsCallback, 'could not extract page paginatedSubmissions callback');

const runFilteredSubmissionsCallback = new Function(
  'scopedSubmissions',
  'selectedForm',
  'assignmentFilter',
  'selectedStatus',
  'dateFrom',
  'dateTo',
  'moment',
  'searchQuery',
  'submissionSearchMatches',
  filteredSubmissionsCallback,
);
const runPaginatedSubmissionsCallback = new Function(
  'filteredSubmissions',
  'currentPage',
  'itemsPerPage',
  paginatedSubmissionsCallback,
);

test('does not match structural initialization keys that JSON.stringify exposed', () => {
  const submission = {
    submission_data: {
      answer: { initialization: { payment_status: 'pending' } },
    },
  };
  const form = { fields: [{ id: 'answer', label: 'Application', type: 'text' }] };

  assert.equal(JSON.stringify(submission.submission_data).toLowerCase().includes('init'), true);
  assert.deepEqual(matchSubmissionSearch(submission, form, 'init'), {
    matches: false,
    excerpt: null,
  });
});

test('finds real nested repeatable answers, not row IDs or metadata', () => {
  const form = {
    fields: [{
      id: 'projects',
      label: 'Projects',
      type: 'repeatable_row',
      child_fields: [{ id: 'description', label: 'Description', type: 'text' }],
    }],
  };
  const submission = {
    submission_data: {
      projects: [{
        _row_id: 'row_initial_internal_id',
        description: 'Initiative for community gardens',
        unrelated_metadata: 'private',
      }],
    },
  };

  assert.deepEqual(submissionSearchAnswers(submission, form), [{
    field: 'Projects · Row 1 · Description',
    value: 'Initiative for community gardens',
  }]);
  assert.equal(matchSubmissionSearch(submission, form, 'INIT').matches, true);
  assert.equal(matchSubmissionSearch(submission, form, 'private').matches, false);
  assert.equal(matchSubmissionSearch(submission, form, 'row_initial').matches, false);
});

test('matches case-insensitively and treats null submission data safely', () => {
  const form = { fields: [{ id: 'note', label: 'Note', type: 'textarea' }] };

  assert.equal(matchSubmissionSearch({ submission_data: { note: 'A Mixed CASE answer' } }, form, 'mixed case').matches, true);
  assert.deepEqual(matchSubmissionSearch({ submission_data: null }, form, 'anything'), {
    matches: false,
    excerpt: null,
  });
  assert.deepEqual(matchSubmissionSearch({ submission_data: null }, form, ''), {
    matches: true,
    excerpt: null,
  });
});

test('searches resolved relationship labels rather than reference IDs', () => {
  const recordId = '6df1b029-5699-4c92-93d8-a6b957fc2f10';
  const form = {
    fields: [{ id: 'department', label: 'Department', type: 'relationship_dropdown' }],
  };
  const submission = { submission_data: { department: recordId } };
  const context = { relationshipLabelsByRecordId: { [recordId]: 'Research & Development' } };

  assert.equal(matchSubmissionSearch(submission, form, 'research', context).matches, true);
  assert.equal(matchSubmissionSearch(submission, form, recordId, context).matches, false);
  assert.equal(matchSubmissionSearch(submission, form, 'Unavailable record').matches, true);
});

test('includes Other free text and nested repeatable choice-label metadata', () => {
  const form = {
    fields: [{
      id: 'teams',
      label: 'Teams',
      type: 'repeatable_row',
      child_fields: [{
        id: 'department',
        label: 'Department',
        type: 'relationship_dropdown',
        not_listed_choice: { enabled: true, label: 'Other department' },
      }],
    }],
  };
  const submission = {
    submission_data: {
      teams: [{
        _row_id: 'row-private-id',
        department: FORM_NOT_LISTED_VALUE,
        __not_listed_choice_text: { department: 'Quantum research' },
      }],
      __not_listed_choice_labels: { teams: { department: 'Other department' } },
    },
  };

  assert.deepEqual(submissionSearchAnswers(submission, form), [{
    field: 'Teams · Row 1 · Department',
    value: 'Other department — Quantum research',
  }]);
  assert.equal(matchSubmissionSearch(submission, form, 'quantum research').matches, true);
  assert.equal(matchSubmissionSearch(submission, form, 'row-private-id').matches, false);
  assert.equal(matchSubmissionSearch(submission, form, '__not_listed_choice_labels').matches, false);
});

test('keeps legacy scalar answers while excluding unknown objects and metadata keys', () => {
  const submission = {
    submission_data: {
      legacy_note: 'A legacy scalar answer',
      legacy_tags: ['older phrase', 'second value'],
      _row_id: 'private row value',
      unrelated_object: { label: 'untrusted nested value' },
    },
  };

  assert.deepEqual(submissionSearchAnswers(submission, { fields: [] }), [
    { field: 'legacy_note', value: 'A legacy scalar answer' },
    { field: 'legacy_tags', value: 'older phrase, second value' },
  ]);
  assert.equal(matchSubmissionSearch(submission, { fields: [] }, 'legacy scalar').matches, true);
  assert.equal(matchSubmissionSearch(submission, { fields: [] }, 'untrusted nested').matches, false);
  assert.equal(matchSubmissionSearch(submission, { fields: [] }, 'private row').matches, false);
});

test('searches readable nested name and address parts, not arbitrary object properties', () => {
  const form = {
    fields: [
      { id: 'applicant', label: 'Applicant', type: 'text' },
      { id: 'address', label: 'Address', type: 'text' },
    ],
  };
  const submission = {
    submission_data: {
      applicant: { first_name: 'Avery', last_name: 'Ng', internal_token: 'private token' },
      address: { line1: '41 Garden Road', city: 'Harborview', reference_id: 'private address id' },
    },
  };

  assert.deepEqual(submissionSearchAnswers(submission, form), [
    { field: 'Applicant', value: 'Avery, Ng' },
    { field: 'Address', value: '41 Garden Road, Harborview' },
  ]);
  assert.equal(matchSubmissionSearch(submission, form, 'avery').matches, true);
  assert.equal(matchSubmissionSearch(submission, form, 'garden road').matches, true);
  assert.equal(matchSubmissionSearch(submission, form, 'private token').matches, false);
  assert.equal(matchSubmissionSearch(submission, form, 'private address').matches, false);
});

test('returns a bounded, field-labelled excerpt around an answer match', () => {
  const answer = `${'a'.repeat(80)}The distinctive phrase appears here.${'z'.repeat(100)}`;
  const result = matchSubmissionSearch(
    { submission_data: { story: answer } },
    { fields: [{ id: 'story', label: 'Applicant story', type: 'text' }] },
    'DISTINCTIVE PHRASE',
  );

  assert.equal(result.matches, true);
  assert.equal(result.excerpt.field, 'Applicant story');
  assert.match(result.excerpt.value, /^…/);
  assert.match(result.excerpt.value, /distinctive phrase/i);
  assert.match(result.excerpt.value, /…$/);
  assert.ok(result.excerpt.value.length <= 162);
});

test('page counts, pagination, selection and exports continue from filtered submissions', () => {
  const source = formSubmissionsSource;

  assert.match(source, /const totalPages = Math\.ceil\(filteredSubmissions\.length \/ itemsPerPage\)/);
  assert.match(source, /return filteredSubmissions\.slice\(startIndex, startIndex \+ itemsPerPage\)/);
  assert.match(source, /const selectAllFiltered = \(\) => \{\s*setSelectedSubmissionIds\(new Set\(filteredSubmissions\.map\(s => s\.id\)\)\)/);
  assert.match(source, /const allFilteredSelected = filteredSubmissions\.length > 0 &&\s*filteredSubmissions\.every/);

  const wordExport = source.slice(source.indexOf('const handleExportWord ='), source.indexOf('const handleDownloadSingleWord ='));
  assert.match(wordExport, /let subs = filteredSubmissions/);
  assert.match(wordExport, /filteredSubmissions\.filter\(s => selectedSubmissionIds\.has\(s\.id\)\)/);
  const csvStart = source.indexOf('const handleExportCSV =');
  const csvEnd = source.indexOf('\n  if (!accessChecked)', csvStart);
  const csvExport = source.slice(csvStart, csvEnd);
  assert.match(csvExport, /filteredSubmissions\.map\(submission =>/);
});

test('preserves feature-access, payment visibility and owned-form restriction branches', () => {
  const source = formSubmissionsSource;
  assert.match(source, /isFeatureExcluded\('page_FormSubmissions'\)/);
  assert.match(source, /const paid = submissions\.filter\(isVisibleFormSubmission\)/);
  assert.match(source, /if \(activeTab === 'owned'\) \{\s*return paid\.filter\(s => ownedFormIds\.has\(s\.form_id\)\)/);
  assert.match(source, /filtered = filtered\.filter\(s => submissionSearchMatches\.get\(s\.id\)\?\.matches\)/);
});

test('executes the page filter, pagination and export-selection callbacks together', () => {
  const form = { fields: [{ id: 'note', label: 'Note', type: 'text' }] };
  const submissions = [
    { id: 'match-1', form_id: 'form-a', status: 'actioned', survey_assignment_id: 'assignment-a', created_date: '2024-05-15T12:00:00Z', submission_data: { note: 'Eligible application' } },
    { id: 'match-2', form_id: 'form-a', status: 'actioned', survey_assignment_id: 'assignment-a', created_date: '2024-05-15T14:00:00Z', submission_data: { note: 'Eligible follow-up' } },
    { id: 'no-search-match', form_id: 'form-a', status: 'actioned', survey_assignment_id: 'assignment-a', created_date: '2024-05-15T12:00:00Z', submission_data: { note: 'Different answer' } },
    { id: 'wrong-form', form_id: 'form-b', status: 'actioned', survey_assignment_id: 'assignment-a', created_date: '2024-05-15T12:00:00Z', submission_data: { note: 'Eligible answer' } },
    { id: 'wrong-status', form_id: 'form-a', status: 'new', survey_assignment_id: 'assignment-a', created_date: '2024-05-15T12:00:00Z', submission_data: { note: 'Eligible answer' } },
    { id: 'wrong-assignment', form_id: 'form-a', status: 'actioned', survey_assignment_id: 'assignment-b', created_date: '2024-05-15T12:00:00Z', submission_data: { note: 'Eligible answer' } },
    { id: 'before-date', form_id: 'form-a', status: 'actioned', survey_assignment_id: 'assignment-a', created_date: '2024-05-14T23:59:59Z', submission_data: { note: 'Eligible answer' } },
    { id: 'after-date', form_id: 'form-a', status: 'actioned', survey_assignment_id: 'assignment-a', created_date: '2024-05-16T00:00:01Z', submission_data: { note: 'Eligible answer' } },
  ];
  const submissionSearchMatches = new Map(submissions.map(submission => [
    submission.id,
    matchSubmissionSearch(submission, form, 'eligible'),
  ]));
  const filteredSubmissions = runFilteredSubmissionsCallback(
    submissions,
    'form-a',
    'assignment-a',
    'actioned',
    '2024-05-15',
    '2024-05-15',
    moment,
    'eligible',
    submissionSearchMatches,
  );

  assert.deepEqual(filteredSubmissions.map(submission => submission.id), ['match-1', 'match-2']);
  const secondPage = runPaginatedSubmissionsCallback(filteredSubmissions, 2, 1);
  assert.deepEqual(secondPage.map(submission => submission.id), ['match-2']);

  const exportSelectionCallback = formSubmissionsSource.match(
    /let subs = filteredSubmissions;([\s\S]*?)\n\n    const baseDate/,
  )?.[1];
  assert.ok(exportSelectionCallback, 'could not extract page export-selection callback');
  const runExportSelectionCallback = new Function(
    'filteredSubmissions',
    'selectedSubmissionIds',
    `let subs = filteredSubmissions;${exportSelectionCallback}\nreturn subs;`,
  );
  assert.deepEqual(
    runExportSelectionCallback(filteredSubmissions, new Set()).map(submission => submission.id),
    ['match-1', 'match-2'],
  );
  assert.deepEqual(
    runExportSelectionCallback(filteredSubmissions, new Set(['match-2'])).map(submission => submission.id),
    ['match-2'],
  );
});