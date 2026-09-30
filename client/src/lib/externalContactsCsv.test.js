import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExternalContacts } from './externalContactsCsv.js';

test('parses accepted contact headers and quoted CSV values', () => {
  const result = parseExternalContacts('first name,last name,email\n"Ada",Lovelace,ada@example.org');
  assert.deepEqual(result.rows, [{ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.org' }]);
});

test('parses positional tab-delimited spreadsheet rows', () => {
  const result = parseExternalContacts('Grace\tHopper\tgrace@example.org');
  assert.deepEqual(result.rows, [{ first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.org' }]);
});

test('reports malformed unterminated quoted CSV', () => {
  assert.equal(parseExternalContacts('Ada,Lovelace,"ada@example.org').error, 'A quoted value is not closed.');
});