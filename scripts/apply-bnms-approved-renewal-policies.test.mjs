import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { main, parseApproval, sha, REPORT, REPORT_HASH, extendGuard } from './apply-bnms-approved-renewal-policies.mjs';

test('the approved report pins exactly 72 histories, seven schedules and five overseas exceptions', async () => {
  const text = await readFile(REPORT, 'utf8');
  assert.equal(sha(text), REPORT_HASH);
  const cohort = parseApproval(text);
  assert.equal(cohort.length, 72);
  assert.equal(new Set(cohort.map(r => r.config.id)).size, 7);
  assert.equal(cohort.filter(r => r.kind === 'Full Overseas').length, 5);
  assert.throws(() => parseApproval(text.replace('| Full UK | 261a9052-8b8c-55d5-a581-fe10cf1031cd | 2026-10-04 |', '')), /cohort/);
  assert.throws(() => parseApproval(text.replace('1c11d958-6af4-5a65-ae92-b10cd9536128', '261a9052-8b8c-55d5-a581-fe10cf1031cd')), /cohort/);
});

test('unreviewed modes and malformed hashes fail before a destination connection', async () => {
  for (const args of [[], ['--apply'], ['--apply', '--plan-sha256=wrong'],
    ['--prepare', '--apply'], ['--replay'], ['--source']]) {
    await assert.rejects(main(args), /Use --prepare/);
  }
});

test('overseas exception refuses an unexpected existing guard contract', () => {
  assert.throws(() => extendGuard('CREATE FUNCTION unexpected()', []), /guard contract/);
});