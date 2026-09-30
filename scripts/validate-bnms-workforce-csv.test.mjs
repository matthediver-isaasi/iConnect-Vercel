import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { main } from './validate-bnms-workforce-csv.mjs';
import { coerceCustomObjectFieldValue } from '../api/_lib/customObjectDomain.js';
import { FILE, parseSource } from './workforce-csv-source.mjs';

test('CLI rejects apply and every other argument before any source or live access', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network must not run'); };
  try {
    for (const args of [['--apply'], ['--dry-run'], ['--source=other.csv'], ['--apply=false']]) {
      await assert.rejects(main(args), /Validation only/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('canonical-whitespace compatibility concern reproduces with the real pure field validator', () => {
  const field = { name: 'staff_group', field_type: 'dropdown',
    options: [{ label: 'Assistant Practitioner ', value: 'Assistant Practitioner ' }] };
  assert.equal(coerceCustomObjectFieldValue('Assistant Practitioner', field).ok, false);
  assert.equal(coerceCustomObjectFieldValue('Assistant Practitioner ', field).ok, false);
  assert.equal(coerceCustomObjectFieldValue('No', {
    name: 'legacy_vacancy_reported', field_type: 'dropdown', options: [{ label: 'no', value: 'No' }],
  }).ok, true);
});

test('only blank answers change; all supplied answers and omitted vacancy values remain intact', () => {
  const bytes = fs.readFileSync(FILE);
  const before = Buffer.from(bytes);
  const source = parseSource(bytes);
  assert.equal(source.rows.filter(r => r.originalLegacy === '').length, 53);
  assert.ok(source.rows.every(r => r.originalLegacy === ''
    ? r.data.legacy_vacancy_reported === 'No' : r.data.legacy_vacancy_reported === r.originalLegacy));
  assert.ok(source.rows.every(r => !Object.hasOwn(r.data, 'vacant_wte')));
  assert.equal(new Set(source.rows.map(r => r.sourceRow)).size, 1242);
  assert.equal(source.rows[0].sourceRow, 2);
  assert.equal(source.rows.at(-1).sourceRow, 1243);
  assert.deepEqual(bytes, before);
});

test('validation modules do not reference apply RPCs, DB mutations, workflows or legacy importer', () => {
  for (const file of ['workforce-readonly-state.mjs', 'workforce-csv-audit.mjs', 'workforce-csv-source.mjs',
    'workforce-validation-report.mjs', 'validate-bnms-workforce-csv.mjs']) {
    const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\.(?:rpc|insert|upsert|delete)\s*\(/, file);
    assert.doesNotMatch(text, /(?:import_pinned_workforce_survey|triggerWorkflows|import-workforce-survey\.mjs)/, file);
    assert.doesNotMatch(text, /process\.env\.(?:SOURCE_|DEV_|DATABASE_URL|SUPABASE_)/, file);
  }
});