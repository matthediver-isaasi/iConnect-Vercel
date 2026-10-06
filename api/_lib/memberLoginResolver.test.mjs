import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemberForTenantLogin, getEffectiveLoginStatusForMember } from './memberLoginResolver.js';

function mockDb(tables) {
  return {
    from(table) {
      let rows = tables[table] || [];
      let single = false;
      const query = {
        select() { return query; },
        eq(key, value) { rows = rows.filter(row => row[key] === value); return query; },
        in(key, values) { rows = rows.filter(row => values.includes(row[key])); return query; },
        not(key, operator, value) {
          assert.equal(operator, 'is');
          rows = rows.filter(row => row[key] !== value); return query;
        },
        filter(key, operator, pattern) {
          assert.equal(key, 'email');
          assert.equal(operator, 'imatch');
          const regex = new RegExp(pattern, 'i');
          rows = rows.filter(row => typeof row[key] === 'string' && regex.test(row[key]));
          return query;
        },
        limit(n) { rows = rows.slice(0, n); return query; },
        maybeSingle() { single = true; return query; },
        then(resolve, reject) {
          return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

const member = { id: 'member-1', tenant_id: 'tenant-1', email: 'Mixed.Case@example.invalid', login_enabled: true };

test('mixed-case stored email resolves the badge without an identity or credentials', async () => {
  const status = await getEffectiveLoginStatusForMember(member, { supabase: mockDb({ member: [member] }) });
  assert.equal(status.resolvedMemberId, member.id);
  assert.equal(status.canLogin, true);
  assert.equal(status.reason, null);
  assert.equal(status.resolutionSource, 'email');
});

test('member email matching remains tenant scoped', async () => {
  const resolution = await resolveMemberForTenantLogin({
    supabase: mockDb({ member: [member] }), email: member.email, tenantId: 'other-tenant',
  });
  assert.equal(resolution.member, null);
  assert.equal(resolution.duplicateActiveMembers.length, 0);
});

test('case variants are included in duplicate warnings without changing identity precedence', async () => {
  const duplicate = { ...member, id: 'member-2', email: member.email.toLowerCase() };
  const status = await getEffectiveLoginStatusForMember({ ...member, identity_id: 'identity-1' }, {
    supabase: mockDb({
      member: [member, duplicate],
      tenant_membership: [{ identity_id: 'identity-1', tenant_id: member.tenant_id, member_id: duplicate.id }],
    }),
  });
  assert.equal(status.resolvedMemberId, duplicate.id);
  assert.equal(status.resolutionSource, 'tenant_membership');
  assert.equal(status.mismatch, true);
  assert.equal(status.duplicateActiveMembers.length, 2);
  assert.ok(status.warnings.includes('duplicate_active_members'));
});

test('tenantless fallback also matches case insensitively', async () => {
  const result = await resolveMemberForTenantLogin({
    supabase: mockDb({ member: [member] }), email: member.email.toUpperCase(),
  });
  assert.equal(result.member.id, member.id);
});

for (const email of [
  'a*b@example.invalid', 'a%b@example.invalid', 'a_b@example.invalid',
  'a+b@example.invalid', 'a.b@example.invalid', 'a(b)[c]{d}?^$|\\@example.invalid',
]) {
  test(`email metacharacters are literal: ${email}`, async () => {
    const exact = { ...member, email };
    const decoys = ['axb@example.invalid', `prefix${email}`, `${email}.suffix`]
      .map((value, index) => ({ ...member, id: `decoy-${index}`, email: value }));
    const result = await resolveMemberForTenantLogin({
      supabase: mockDb({ member: [...decoys, exact] }), email: email.toUpperCase(), tenantId: member.tenant_id,
    });
    assert.equal(result.member.id, member.id);
    assert.equal(result.duplicateActiveMembers.length, 1);
  });
}

for (const [changes, reason] of [
  [{ login_enabled: false }, 'login_disabled'],
  [{ membership_paused: true }, 'membership_paused'],
  [{ is_guest: true, guest_expires_at: '2000-01-01T00:00:00Z' }, 'guest_expired'],
  [{ email: 'deleted_fixture@deleted.local' }, 'no_member'],
]) {
  test(`case-insensitive resolution preserves blocking reason ${reason}`, async () => {
    const row = { ...member, ...changes };
    const status = await getEffectiveLoginStatusForMember(row, { supabase: mockDb({ member: [row] }) });
    assert.equal(status.canLogin, false);
    assert.equal(status.reason, reason);
  });
}

test('existing credential locks remain effective after mixed-case resolution', async () => {
  const status = await getEffectiveLoginStatusForMember(member, {
    supabase: mockDb({
      member: [member],
      member_credentials: [{ member_id: member.id, locked_until: '2999-01-01T00:00:00Z' }],
    }),
  });
  assert.equal(status.canLogin, false);
  assert.equal(status.reason, 'account_locked');
});
