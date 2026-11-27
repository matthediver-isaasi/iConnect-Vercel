import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelease, REVIEW_SHA256, PROJECT } from './registration-association-multi-values-release.mjs';

test('offline default reports the approved artifact without database access', async () => {
  const plan = await buildRelease();
  assert.equal(plan.project, PROJECT);
  assert.equal(plan.sha256, REVIEW_SHA256);
  assert.equal(plan.connectsToDatabase, false);
  assert.equal(plan.query, undefined);
});
test('release requires explicit approval, exact hash, mode and no extra arguments', async () => {
  for (const args of [
    ['--mode=install'], ['--approved', '--mode=install', '--review-sha256=wrong'],
    ['--approved', `--review-sha256=${REVIEW_SHA256}`, '--mode=install', '--other'],
  ]) await assert.rejects(buildRelease(args));
});
test('installation is bounded, prerequisite-guarded, schema-only and verifies preservation', async () => {
  const { query } = await buildRelease(['--approved', `--review-sha256=${REVIEW_SHA256}`, '--mode=install']);
  assert.match(query, /202612090011 differ/);
  assert.match(query, /Extension already exists; verify, never replay/);
  assert.match(query, /Existing functions or grants changed/);
  assert.match(query, /Expected role execution denial/);
  assert.match(query, /SET LOCAL ROLE service_role/);
  assert.doesNotMatch(query, /\b(?:INSERT INTO|UPDATE public\.|DELETE FROM|TRUNCATE|DROP TABLE)\b/i);
  assert.equal((query.match(/^BEGIN;/gm) || []).length, 1);
  assert.equal((query.match(/^COMMIT;/gm) || []).length, 1);
});
test('rehearsal rolls back DDL in an exception subtransaction and rechecks absence', async () => {
  const { query } = await buildRelease(['--approved', `--review-sha256=${REVIEW_SHA256}`, '--mode=rehearse']);
  assert.match(query, /EXCEPTION WHEN SQLSTATE 'P5943' THEN NULL/);
  assert.equal((query.match(/Extension already exists; verify, never replay/g) || []).length, 2);
});
test('verification is read-only and does not call an event or any business writer', async () => {
  const { query } = await buildRelease(['--approved', `--review-sha256=${REVIEW_SHA256}`, '--mode=verify']);
  assert.match(query, /^BEGIN READ ONLY;/);
  assert.doesNotMatch(query, /CREATE|provision_public_ticket_members\(NULL|insert_public_ticket_booking_batch\(NULL/);
  assert.match(query, /eventDiscoverySearchPerformed',false/);
});
