import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveMemberBadgeEvents } from './memberBadgeEvents.js';
import { loadActiveSelfBadges } from './selfMemberBadges.js';
import { awardSourceLabel, resolveBadgeActor } from './memberBadgeAttribution.js';
import { badgeDatabase } from './memberBadgeEvents.fixtures.mjs';

const migration = await readFile(new URL('../../supabase/migrations/20260826_member_badge_history.sql', import.meta.url), 'utf8');
const route = await readFile(new URL('../admin/members/[memberId]/badges.js', import.meta.url), 'utf8');
const speakerAwards = await readFile(new URL('./speakerAwards.js', import.meta.url), 'utf8');
const entityRoute = await readFile(new URL('../entities/[entity]/[id].js', import.meta.url), 'utf8');
const cpdMigration = await readFile(new URL('../../supabase/migrations/20261011_event_cpd_badge_awards.sql', import.meta.url), 'utf8');

// Execute the real route body with only infrastructure/access dependencies
// injected. No credentials, network access or database writes are involved.
function handlerFor(database, context, access = { ok: true }) {
  return new Function('supabase', 'getTenantContext', 'checkBadgeWriteAccess', 'checkMemberBadgeTargetAccess', 'awardSourceLabel', 'resolveBadgeActor', 'resolveMemberBadgeEvents',
    route.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'return async function handler'))(
    database, async () => context, async () => ({ ok: false }), async () => access,
    awardSourceLabel, resolveBadgeActor, resolveMemberBadgeEvents,
  );
}
function response() {
  return { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('real staff history response enriches active/revoked credentials with the same safe context as self badges', async () => {
  const scope = { tenant_id: 't1', member_id: 'm1' };
  const active = { ...scope, id: 'active', badge_id: 'b', source: 'manual', awarded_at: '2026-01-01', revoked_at: null, awarded_by_label: 'Original staff', badge: { id: 'b', name: 'Speaker', is_active: true } };
  const revoked = { ...active, id: 'revoked', revoked_at: '2026-01-02', revoked_by_label: 'Revoking staff' };
  const db = badgeDatabase({
    member: [{ id: 'm1', tenant_id: 't1' }],
    member_badge: [active, revoked, { ...active, id: 'foreign', tenant_id: 't2' }],
    speaker_award_grant: ['active', 'revoked'].map(id => ({
      ...scope, id: `g-${id}`, member_badge_id: id, badge_id: 'b', event_type: 'event', event_id: 'e',
      private_field: 'private voucher and recipient details',
    })),
    event: [{ id: 'e', tenant_id: 't1', title: 'Parent event', start_date: '2026-05-01', timezone: 'Europe/London' }],
  });
  const context = { isAuthenticated: true, tenantId: 't1', memberId: 'm1' };
  const res = response();
  await handlerFor(db, context)({ method: 'GET', query: { memberId: 'm1', tenant_id: 't2' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.awards.map(row => row.status), ['active', 'revoked']);
  assert.equal(res.body.awards[1].revoked_by_label, 'Revoking staff');
  assert.equal(res.body.awards[0].awarded_by_label, 'Original staff');
  assert.equal(res.body.awards[0].speaker_events[0].event_start_date, '2026-05-01');
  assert.equal(JSON.stringify(res.body).includes('private voucher'), false);
  const self = await loadActiveSelfBadges(db, context);
  assert.equal(self.badges.length, 1);
  assert.deepEqual(self.badges[0].speaker_events, res.body.awards[0].speaker_events);
  assert.equal(self.badges[0].awarded_at, active.awarded_at);
});

test('staff history retains authentication and target-access checks before event reads', async () => {
  for (const [context, access, expected] of [
    [null, { ok: true }, 401],
    [{ isAuthenticated: true }, { ok: true }, 403],
    [{ isAuthenticated: true, tenantId: 't1' }, { ok: false, status: 403, error: 'Forbidden' }, 403],
  ]) {
    const unused = { from() { throw new Error('Unexpected database read'); } };
    const res = response();
    await handlerFor(unused, context, access)({ method: 'GET', query: { memberId: 'm1' } }, res);
    assert.equal(res.code, expected);
  }
});

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
  assert.match(route, /resolveMemberBadgeEvents\(supabase, \{ tenantId, memberId, awards: data \|\| \[\] \}\)/);
  assert.match(route, /speaker_events: events\.get\(row\.id\)/);
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

test('badge delete keeps both member and CPD history references intact', () => {
  assert.match(migration, /FOREIGN KEY \(badge_id\)[\s\S]*ON DELETE RESTRICT/i);
  assert.match(cpdMigration, /badge_id uuid REFERENCES public\.badge\(id\) ON DELETE RESTRICT/i);
  assert.match(entityRoute, /checkBadgeWriteAccess\(tenantCtx\)/);
  assert.match(entityRoute, /deleteOrDeactivateBadge\(supabase/);
  assert.match(entityRoute, /tenantCtx\.effectiveTenantId \|\| tenantCtx\.tenantId/);
});