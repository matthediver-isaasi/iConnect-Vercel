import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { main, MIGRATION } from './apply-cancelled-campaign-removal.mjs';

test('cancelled removal rollout is offline by default and pins hash and DEST before connecting', async () => {
  await main([], {});
  for (const args of [['--apply'],['--apply',`--review-sha256=${'0'.repeat(64)}`]]) {
    await assert.rejects(main(args, {}), /SHA-256/);
  }
  await assert.rejects(main(['--apply','--apply'], {}), /Supported/);
  const hash=createHash('sha256').update(readFileSync(`supabase/migrations/${MIGRATION}`)).digest('hex');
  await assert.rejects(main(['--apply',`--review-sha256=${hash}`], {
    DEST_DATABASE_URL:'postgresql://postgres:invalid@db.wrong.supabase.co/postgres',
    DEST_SUPABASE_URL:'https://wrong.supabase.co',
  }),/pin mismatch/);
});
