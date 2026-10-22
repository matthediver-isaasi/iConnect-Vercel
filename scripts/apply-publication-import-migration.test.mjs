import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './apply-publication-import-migration.mjs';

test('publication migration review is offline and apply rejects missing/mismatched approval', async () => {
  await main([], {});
  await assert.rejects(main(['--apply'], {}), /hash/);
  await assert.rejects(main(['--apply', `--review-sha256=${'0'.repeat(64)}`], {}), /hash/);
  await assert.rejects(main(['--force'], {}), /Use/);
});
