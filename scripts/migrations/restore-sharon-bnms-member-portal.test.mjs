import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(
  new URL('./restore-sharon-bnms-member-portal.sql', import.meta.url),
  'utf8',
);

test('recovery is pinned to Sharon and the exact BNMS auth graph', () => {
  assert.match(sql, /ff2df806-b321-4254-b651-3af11fccf1db/);
  assert.match(sql, /dc156a30-ae8d-4aee-b965-b54fe4b17105/);
  assert.match(sql, /6111f611-9daf-4011-847c-86e2bc616740/);
  assert.match(sql, /3d291826-13d8-4fc1-9221-7627fc45830a/);
  assert.match(sql, /sharon@onlinem\.co\.uk/);
  assert.match(sql, /tm\.role = 'admin'/);
  assert.match(sql, /tm\.membership_type = 'owner'/);
});

test('recovery accepts only the zero-member baseline or exact idempotent state', () => {
  assert.match(sql, /v_tenant_member_count = 0/);
  assert.match(sql, /v_tenant_member_count = 1/);
  assert.match(sql, /v_exact_member_count = 1/);
  assert.match(sql, /Expected zero BNMS Members or the exact applied state/);
  assert.match(sql, /Exact recovery state already exists; this run is an idempotent no-op/);
  assert.match(
    sql,
    /UPDATE public\.tenant_membership[\s\S]*AND tm\.member_id IS NULL;/,
    'an exact replay must not touch the already-linked membership timestamp',
  );
});

test('recovery creates only the minimal private active Member and existing link', () => {
  assert.match(sql, /INSERT INTO public\.member/);
  assert.match(sql, /UPDATE public\.tenant_membership/);
  assert.match(sql, /'active',\s*true,\s*false,\s*false,\s*false,\s*false/s);
  assert.match(sql, /organization_id IS NULL/);
  assert.match(sql, /show_in_directory IS FALSE/);
  assert.doesNotMatch(sql, /INSERT INTO public\.tenant_identity/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.tenant_membership\s/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.tenant_membership_credentials/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.tenant_user\s/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.organization/i);
});

test('recovery checks portal eligibility and all auth-boundary postconditions', () => {
  assert.match(sql, /member_portal_login_enabled/);
  assert.match(sql, /BNMS member portal is explicitly disabled/);
  assert.match(sql, /tm\.member_id::text = s\.member_id::text/);
  assert.match(sql, /m\.login_enabled IS TRUE/);
  assert.match(sql, /m\.membership_paused IS NOT TRUE/);
  assert.match(sql, /BNMS does not have exactly one Member/);
  assert.match(sql, /Auth-boundary postcondition failed/);
});

test('recovery is one locked transaction and rolls back by default', () => {
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /LOCK TABLE[\s\S]*IN SHARE ROW EXCLUSIVE MODE/);

  const transactionEndings = [...sql.matchAll(/^\s*(COMMIT|ROLLBACK)\s*;/gim)]
    .map((match) => match[1].toUpperCase());
  assert.deepEqual(transactionEndings, ['ROLLBACK']);
  assert.match(sql, /replace this[\s\S]*ROLLBACK line with exactly COMMIT/i);
});