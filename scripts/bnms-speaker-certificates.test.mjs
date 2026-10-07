import test from 'node:test';
import assert from 'node:assert/strict';
import { recipients, recognitionId, EVENT, TEMPLATE } from './bnms-speaker-certificates.mjs';
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
function fixture() {
  return {
    event: { id: EVENT, tenant_id: tenant, status: 'published', event_state: 'closed',
      start_date: '2026-09-24', end_date: '2026-09-25', speaker_award_config: {
        enabled: true, default: { certificate_template_id: TEMPLATE }, overrides: {},
      } },
    tenant: { id: tenant, slug: 'bnms' }, ids: ['a', 'b'],
    speakers: [{ id: 'a', member_id: 'm', full_name: 'Test Speaker' }, { id: 'b', email: 'same@example.test' }],
    grants: [], members: [{ id: 'm', tenant_id: tenant, email: 'same@example.test' }],
    template: { id: TEMPLATE, tenant_id: tenant, status: 'active', source_bucket: 'private-uploads',
      source_path: `${tenant}/template.pdf`, source_sha256: 'a'.repeat(64) },
    fields: [], policy: { starts_at: '2026-09-29' },
  };
}
test('uses persisted links only; no email ownership inference', () => {
  const rows = recipients(fixture());
  assert.equal(rows[0].memberId, 'm');
  assert.equal(rows[1].skipped, 'unlinked');
  assert.equal(rows[0].snapshot.event_start_date, '2026-09-24');
});
test('persisted grant can resolve ownership, but conflicting links fail closed', () => {
  const f = fixture(); f.grants = [{ speaker_id: 'b', member_id: 'm' }];
  assert.equal(recipients(f)[1].memberId, 'm');
  f.grants.push({ speaker_id: 'a', member_id: 'other' });
  assert.throws(() => recipients(f), /Conflicting/);
});
for (const [name, mutate] of [
  ['other event', f => { f.event.id = 'other'; }],
  ['other tenant', f => { f.event.tenant_id = 'other'; }],
  ['unpublished event', f => { f.event.status = 'draft'; }],
  ['changed dates', f => { f.event.start_date = '2026-09-23'; }],
  ['voucher config', f => { f.event.speaker_award_config.default.voucher_value = 100; }],
  ['badge config', f => { f.event.speaker_award_config.default.badge_id = 'badge'; }],
  ['override', f => { f.event.speaker_award_config.overrides.a = { excluded: true }; }],
  ['inactive template', f => { f.template.status = 'inactive'; }],
  ['wrong template tenant', f => { f.template.tenant_id = 'other'; }],
  ['public source', f => { f.template.source_bucket = 'public'; }],
  ['wrong field tenant', f => { f.fields.push({ tenant_id: 'other' }); }],
  ['policy change', f => { f.policy.starts_at = '2026-09-01'; }],
  ['missing linked member', f => { f.members = []; }],
  ['wrong member tenant', f => { f.members[0].tenant_id = 'other'; }],
  ['deleted member', f => { f.members[0].email = 'deleted_123@deleted.local'; }],
  ['duplicate grants', f => { f.grants = [{ speaker_id: 'a' }, { speaker_id: 'a' }]; }],
]) test(`fails closed: ${name}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => recipients(f));
});
test('stable per-speaker IDs preserve crash-recovery artifact keys', () => {
  assert.equal(recognitionId('a'), recognitionId('a'));
  assert.notEqual(recognitionId('a'), recognitionId('b'));
  assert.match(recognitionId('a'), /^[a-f0-9-]{36}$/);
});
