import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { main } from './apply-campaign-lifecycle.mjs';

test('lifecycle migration runner stays offline unless hash and pinned target are approved', async () => {
  await main([], {});
  await assert.rejects(main(['--apply'], {}), /SHA-256/);
  await assert.rejects(main(['--apply', `--review-sha256=${'0'.repeat(64)}`], {}), /SHA-256/);
  await assert.rejects(main(['--verify'], {}), /Supported/);
  await assert.rejects(main(['--apply', '--apply'], {}), /Supported/);
  const hash=createHash('sha256').update(readFileSync('supabase/migrations/202612310006_campaign_lifecycle.sql')).digest('hex');
  await assert.rejects(main(['--apply', `--review-sha256=${hash}`], {
    DEST_DATABASE_URL:'postgresql://postgres:invalid@db.wrong.supabase.co/postgres',
    DEST_SUPABASE_URL:'https://wrong.supabase.co',
  }), /pin mismatch/);
});
