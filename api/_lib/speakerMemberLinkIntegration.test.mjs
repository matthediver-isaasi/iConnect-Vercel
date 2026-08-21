import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('speaker create and update routes enforce the shared tenant and duplicate guard', () => {
  for (const relativePath of [
    'api/entities/[entity]/index.js',
    'api/entities/[entity]/[id].js',
  ]) {
    const source = read(relativePath);
    assert.match(source, /validateSpeakerMemberLink\(\{/);
    assert.match(source, /hasFeatureAccess\(tenantCtx\.roleId, 'events\.speakers'\)/);
    assert.match(source, /isSpeakerMemberUniqueViolation\(error\)/);
    assert.match(source, /DUPLICATE_SPEAKER_MEMBER/);
  }
});

test('speaker update route explicitly permits link switching and clearing', () => {
  const source = read('api/entities/[entity]/[id].js');
  assert.match(source, /entitiesAllowingMemberReassign = \['discountcode', 'speaker'\]/);
  assert.match(source, /hasOwnProperty\.call\(sanitizedBody, 'member_id'\)/);
  assert.match(source, /memberId: sanitizedBody\.member_id/);
  assert.match(source, /excludeSpeakerId: id/);
});

test('speaker management reads require speaker-management access and return link data', () => {
  const source = read('api/admin/speakers/paginated.js');
  assert.match(source, /hasFeatureAccess\(tenantCtx\.roleId, 'events\.speakers'\)/);
  assert.match(source, /member_id/);
  assert.match(source, /linked_member/);
});

test('member search permits speaker managers and remains tenant-scoped', () => {
  const source = read('api/members/search.js');
  assert.match(source, /hasFeatureAccess\(tenantContext\.roleId, 'events\.speakers'\)/);
  assert.match(source, /\.eq\('tenant_id', tenantId\)/);
  assert.match(source, /linked_speaker_id/);
});

test('migration keeps guests nullable, clears links on member removal, and prevents duplicates', () => {
  const source = read('supabase/migrations/20260821_speaker_member_link.sql');
  assert.match(source, /member_id UUID REFERENCES public\.member\(id\) ON DELETE SET NULL/);
  assert.match(source, /speaker_tenant_member_unique/);
  assert.match(source, /WHERE member_id IS NOT NULL/);
  assert.match(source, /enforce_speaker_member_same_tenant/);
  assert.match(source, /ERRCODE = '23503'/);
});