import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COLUMN_COUNT, EXPECTED_FILE_SHA256, FILE, HEADERS, ROW_COUNT, parseSourceBytes,
} from './import-bnms-overseas-members.mjs';

test('pins and parses the corrected BNMS overseas workbook', () => {
  const source = parseSourceBytes(readFileSync(FILE));
  assert.equal(source.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(HEADERS.length, COLUMN_COUNT);
  assert.equal(HEADERS[0], 'ym_web_site_member_id');
  assert.deepEqual(source.counts, { organization: 33, none: 3, uniqueOrganizations: 31 });
  assert.equal(new Set(source.rows.map((row) => row.email)).size, ROW_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.legacyId)).size, ROW_COUNT);
});

test('corrected phones contain only full text digits with an optional plus', () => {
  const source = parseSourceBytes(readFileSync(FILE));
  const phones = source.rows.map((row) => row.values[17]).filter(Boolean);
  assert.equal(phones.length, 26);
  assert.ok(phones.every((value) => /^\+?\d{6,15}$/.test(value)));
  assert.ok(phones.every((value) => !/[Ee.-]/.test(value)));
});

test('Member Since remains a core positional source column', () => {
  const source = parseSourceBytes(readFileSync(FILE));
  assert.ok(source.rows.every((row) => /^\d{2}\/\d{2}\/\d{4}$/.test(row.values[1])));
});

test('normalizes the workbook capitalization to the exact live Member class option', () => {
  const source = parseSourceBytes(readFileSync(FILE));
  assert.equal(source.rows.filter((row) => row.values[5] === 'Overseas associate').length, 8);
  assert.equal(source.rows.filter((row) => row.values[5] === 'Overseas Associate').length, 0);
});