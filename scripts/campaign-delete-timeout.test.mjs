import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignLifecycle, campaignLifecycleError } from '../api/_lib/campaignLifecycle.js';
import { main } from './apply-campaign-delete-indexes.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('confirmed database timeout preserves diagnostic code and reports retry without success', async () => {
  const result = await campaignLifecycle({ rpc: async () => ({error:{code:'57014',message:'canceling statement due to statement timeout'}}) },'campaign','tenant','delete');
  assert.equal(result.success,false);
  assert.equal(result.code,'57014');
  assert.equal(result.statusCode,503);
  assert.match(result.error,/No changes were made.*retry/);
  assert.equal(campaignLifecycleError({code:'23503'}).statusCode,409);
  assert.equal(campaignLifecycleError({code:'55000',message:'protected'}).error,'protected');
});

test('index rollout is offline by default and requires hash plus pinned DEST', async () => {
  await main([], {});
  await assert.rejects(main(['--apply'],{}),/SHA-256/);
  await assert.rejects(main(['--apply','--apply'],{}),/Supported/);
  await assert.rejects(main(['--other'],{}),/Supported/);
  const hash=createHash('sha256').update(readFileSync('supabase/migrations/202612310007_campaign_delete_fk_indexes.sql')).digest('hex');
  await assert.rejects(main(['--apply',`--review-sha256=${hash}`],{
    DEST_DATABASE_URL:'postgresql://postgres:invalid@db.wrong.supabase.co/postgres',
    DEST_SUPABASE_URL:'https://wrong.supabase.co',
  }),/pin mismatch/);
});
