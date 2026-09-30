import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeExternalContactRows,
  normalizeExternalContactEmail,
  validateExternalContactRow,
} from './externalContactRows.js';

test('normalizes email case and surrounding whitespace', () => {
  assert.equal(normalizeExternalContactEmail('  Person@Example.COM '), 'person@example.com');
  assert.equal(normalizeExternalContactEmail(null), '');
});

test('validates and trims all required contact fields', () => {
  const result = validateExternalContactRow({
    first_name: ' Ada ',
    last_name: ' Lovelace ',
    email: ' ADA@Example.org ',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, {
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ADA@Example.org',
    normalized_email: 'ada@example.org',
  });

  const invalid = validateExternalContactRow({ first_name: '', email: 'not-an-email' });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors, [
    'First name is required',
    'Last name is required',
    'Email is invalid',
  ]);
});

test('reports invalid, existing, and repeated input rows without dropping any row', () => {
  const rows = [
    { first_name: 'A', last_name: 'One', email: 'new@example.com' },
    { first_name: 'B', last_name: 'Two', email: ' EXISTING@example.com ' },
    { first_name: 'C', last_name: 'Three', email: 'NEW@EXAMPLE.COM' },
    { first_name: '', last_name: 'Four', email: 'bad' },
  ];
  const outcomes = analyzeExternalContactRows(rows, ['existing@example.com']);
  assert.equal(outcomes.length, rows.length);
  assert.deepEqual(outcomes.map((item) => item.status), [
    'valid',
    'duplicate_existing',
    'duplicate_input',
    'invalid',
  ]);
});