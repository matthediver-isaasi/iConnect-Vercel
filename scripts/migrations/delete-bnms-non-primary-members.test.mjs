import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(
  new URL('./delete-bnms-non-primary-members.sql', import.meta.url),
  'utf8',
);

test('BNMS cleanup SQL pins tenant identity and fails closed on primary ambiguity', () => {
  assert.match(sql, /ff2df806-b321-4254-b651-3af11fccf1db/);
  assert.match(sql, /British Nuclear Medicine Society/);
  assert.match(sql, /v_primary_count <> 1/);
  assert.doesNotMatch(sql, /order by created_at[\s\S]*limit 1/i);
});

test('BNMS cleanup SQL snapshots candidates, preserved members, and other tenants', () => {
  assert.match(sql, /CREATE TEMP TABLE _bnms_candidates/);
  assert.match(sql, /organization_id IS DISTINCT FROM s\.primary_organization_id/);
  assert.match(sql, /CREATE TEMP TABLE _bnms_preserved/);
  assert.match(sql, /CREATE TEMP TABLE _other_tenant_members/);
});

test('BNMS cleanup SQL discovers dependencies and protects shared identities', () => {
  assert.match(sql, /FROM pg_constraint fk/);
  assert.match(sql, /Cross-tenant guard/);
  assert.match(sql, /x\.%I::text = c\.id::text/);
  assert.match(sql, /Restrictive child dependencies would make cleanup order unsafe/);
  assert.match(sql, /tenant_identity rows are reported,[\s\S]*not deleted/i);
  assert.match(sql, /candidate and preserved BNMS member share an identity/i);
  assert.match(sql, /'portal_sso_token'/);
  assert.doesNotMatch(sql, /DELETE FROM public\.tenant_identity/i);
});

test('BNMS cleanup SQL proves postconditions and rolls back by default', () => {
  assert.match(sql, /LOCK TABLE public\.tenant, public\.organization, public\.member IN SHARE MODE/);
  assert.match(sql, /at least one candidate member remains/);
  assert.match(sql, /a live BNMS non-primary member remains/);
  assert.match(sql, /at least one preserved primary-organisation member was removed/);
  assert.match(sql, /at least one out-of-tenant member was removed/);
  assert.match(sql, /dangling candidate reference/);

  const transactionEndings = [...sql.matchAll(/^\s*(COMMIT|ROLLBACK)\s*;/gim)]
    .map((match) => match[1].toUpperCase());
  assert.deepEqual(transactionEndings, ['ROLLBACK']);
  assert.match(sql, /replace the ROLLBACK line above with exactly COMMIT/);
});