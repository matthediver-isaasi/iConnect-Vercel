// Tests for the shared form-submission PDF builder (Task #3312).
// jsPDF writes uncompressed content streams by default, so rendered text is
// searchable in the raw PDF bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFormSubmissionPdf } from './formSubmissionPdf.js';

const FIELDS = [
  { id: 'name', label: 'Full name', type: 'text' },
  { id: 'skills', label: 'Skills', type: 'multiselect' },
  { id: 'agree', label: 'Agree to terms', type: 'boolean' },
  { id: 'contact', label: 'Contact details', type: 'contact' },
  { id: 'cv', label: 'CV upload', type: 'file_upload' },
  { id: 'note', label: 'Heading', type: 'heading' },
];

const DATA = {
  name: 'Ada Lovelace',
  skills: ['Maths', 'Programming'],
  agree: true,
  contact: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
  cv: { name: 'ada-cv.pdf' },
};

test('builds a PDF buffer with rendered labels and values', () => {
  const buf = buildFormSubmissionPdf({
    title: 'Treasurer application',
    dateLabel: 'Submitted: 1 May 2026',
    fields: FIELDS,
    submissionData: DATA,
  });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const text = buf.toString('latin1');
  assert.ok(text.includes('Treasurer application'));
  assert.ok(text.includes('Submitted: 1 May 2026'));
  assert.ok(text.includes('Full name'));
  assert.ok(text.includes('Ada Lovelace'));
  assert.ok(text.includes('Maths, Programming'));
  assert.ok(text.includes('Yes'));
  assert.ok(text.includes('[Uploaded: ada-cv.pdf]'));
  // heading fields are skipped
  assert.ok(!text.includes('Heading'));
});

test('renders placeholders for missing values and sanitises non-WinAnsi text', () => {
  const buf = buildFormSubmissionPdf({
    title: 'Vacancy \u2014 Chair',
    fields: [
      { id: 'a', label: 'Answer', type: 'text' },
      { id: 'f', label: 'File', type: 'file' },
    ],
    submissionData: { f: null },
  });
  const text = buf.toString('latin1');
  // em dash normalised to '-'
  assert.ok(text.includes('Vacancy - Chair'));
  assert.ok(text.includes('[No file uploaded]'));
});
