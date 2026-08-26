import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../../supabase/migrations/20260826_member_badge_history.sql', import.meta.url), 'utf8');
const route = await readFile(new URL('../admin/members/[memberId]/badges.js', import.meta.url), 'utf8');
const speakerAwards = await readFile(new URL('./speakerAwards.js', import.meta.url), 'utf8');

test('history migration replaces permanent uniqueness with active-only uniqueness', () => {
  assert.match(migration, /DROP CONSTRAINT IF EXISTS member_badge_badge_id_member_id_key/);
  assert.match(migration, /UNIQUE INDEX[\s\S]*tenant_id, member_id, badge_id[\s\S]*WHERE revoked_at IS NULL/i);
  assert.match(migration, /FOREIGN KEY \(badge_id\)[\s\S]*ON DELETE RESTRICT/i);
});

test('member badge route scopes member, badge, assignment reads and writes to tenant', () => {
  assert.ok((route.match(/\.eq\('tenant_id',/g) || []).length >= 6);
  assert.match(route, /\.eq\('member_id', memberId\)/);
  assert.match(route, /checkBadgeWriteAccess/);
  assert.match(route, /checkMemberBadgeTargetAccess/);
  assert.match(route, /cannot award or revoke your own badges/i);
});

test('duplicate active awards conflict while revocation is an audited update', () => {
  assert.match(route, /error\?\.code === '23505'/);
  assert.match(route, /revoked_at: now/);
  assert.match(route, /revoked_by_label: actor\.label/);
  assert.match(route, /\.is\('revoked_at', null\)/);
});

test('automatic speaker awards write readable attribution and only dedupe active awards', () => {
  assert.match(speakerAwards, /awarded_by_label: 'Speaker awards automation'/);
  assert.match(speakerAwards, /\.is\('revoked_at', null\)/);
});