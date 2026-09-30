import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MIGRATION, assertReviewHash, main, validateArgs } from './apply-campaign-preparation.mjs';

test('offline argument validation accepts dry-run review and exact apply hash only', async () => {
  const sql = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');

  assert.deepEqual(validateArgs([]), { apply: false, reviewHash: undefined });
  assert.deepEqual(validateArgs([`--review-sha256=${sha256}`]), { apply: false, reviewHash: sha256 });
  assert.deepEqual(assertReviewHash(['--apply', `--review-sha256=${sha256}`], sha256),
    { apply: true, reviewHash: sha256 });
  assert.throws(() => assertReviewHash(['--apply'], sha256), /requires --review-sha256/);
  assert.throws(() => assertReviewHash(['--apply', `--review-sha256=${'0'.repeat(64)}`], sha256),
    /requires --review-sha256/);
  assert.throws(() => validateArgs(['--apply', '--apply']), /Supported arguments/);
  assert.throws(() => validateArgs(['--review-sha256=ABC']), /Supported arguments/);
  assert.throws(() => validateArgs(['--unexpected']), /Supported arguments/);
});

test('apply without the exact SHA is rejected offline before checking destination credentials', async () => {
  await assert.rejects(main(['--apply']), /requires --review-sha256/);
});