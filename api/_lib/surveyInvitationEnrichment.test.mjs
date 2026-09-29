import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolveInvitationPrefill, invitationBookingFingerprint } from './surveyInvitationEnrichment.js';
import { redactIdentityAnswers } from './surveyScoring.js';
import handler from '../public/survey-assignment/[token].js';
import { certificateSurveyTokenHash } from './certificateSurveyGrants.js';

const customId = '11111111-1111-4111-8111-111111111111';
const fields = [
  { id: 'name', prefill_field: 'member:first_name' },
  { id: 'full', prefill_field: 'member:full_name' },
  { id: 'org', prefill_field: 'org:name' },
  { id: 'custom', prefill_field: `custom:${customId}`, type: 'list' },
  { id: 'orgCustom', prefill_field: `org_custom:${customId}` },
  { id: 'relationship', type: 'organisation_dropdown' },
  { id: 'group', type: 'organisation_group_dropdown' },
  { id: 'secret', prefill_field: 'member:password_hash' },
  { id: 'legacy', prefill_field: 'job_title' },
];
function fixture() {
  const rows = {
    survey_invitation_attendee: [],
    member: [{ id: 'attendee', tenant_id: 'tenant', email: 'a@test.org', first_name: 'Member Ada', job_title: 'Engineer',
      organization_id: 'org', organization_group_id: 'group', password_hash: 'NEVER EXPOSE' }],
    organization: [{ id: 'org', tenant_id: 'tenant', name: 'Attendee org' }],
    organization_group: [{ id: 'group', tenant_id: 'tenant' }],
    preference_field: ['member', 'organization'].map(entity_scope => ({ id: customId, tenant_id: 'tenant', entity_scope, is_active: true })),
    member_preference_value: [{ field_id: customId, member_id: 'attendee', value: '["One","Two"]' }],
    organization_preference_value: [{ field_id: customId, organization_id: 'org', value: 'Org answer' }],
  };
  const reads = [];
  let writes = 0;
  const db = {
    async rpc(name, args) {
      assert.equal(name, 'confirm_survey_invitation_attendee');
      writes++;
      rows.survey_invitation_attendee = [{ entitlement_id: args.p_entitlement_id, tenant_id: args.p_tenant_id,
        member_id: args.p_member_id, recipient_email: 'a@test.org', booking_fingerprint: args.p_booking_fingerprint }];
      return { data: null };
    },
    from(table) {
    const filters = [];
    let input;
    const q = {
      select(columns) { reads.push({ table, columns }); return q; },
      eq(key, value) { filters.push(r => r[key] === value); return q; },
      in(key, values) { filters.push(r => values.includes(r[key])); return q; },
      upsert(value) { input = value; return q; },
      maybeSingle() { return Promise.resolve({ data: rows[table].find(r => filters.every(f => f(r))) || null }); },
      then(resolve, reject) {
        if (input) { writes++; rows[table] = [input]; }
        return Promise.resolve({ data: rows[table].filter(r => filters.every(f => f(r))) }).then(resolve, reject);
      },
    };
    return q;
  } };
  const invited = { status: 'active', credential: { id: 'credential' }, grant: { id: 'grant', recipient_email: 'a@test.org' },
    booking: { id: 'booking', attendee_email: 'a@test.org', attendee_first_name: 'Booking Ada', member_id: 'purchaser' } };
  const args = { db, tenantId: 'tenant', invited, fields, settings: { invitation_prefill_config: { source: 'member' } } };
  return { rows, reads, args, writes: () => writes };
}

test('read-only bearer does not infer a member; explicit confirmation persists field-scoped subsequent anonymous enrichment', async () => {
  const f = fixture();
  const unlinked = await resolveInvitationPrefill(f.args);
  assert.equal(unlinked.association.status, 'unlinked');
  assert.equal(unlinked.values.name, 'Booking Ada');
  assert.equal(f.writes(), 0);
  assert.equal(f.reads.some(r => r.table === 'member'), false);
  const linked = await resolveInvitationPrefill({ ...f.args, sessionMember: f.rows.member[0], confirm: true });
  assert.equal(linked.association.status, 'linked');
  assert.deepEqual(linked.values, { name: 'Member Ada', full: 'Member Ada', org: 'Attendee org', custom: ['One', 'Two'],
    orgCustom: 'Org answer', relationship: 'org', group: 'group', legacy: 'Engineer' });
  assert.deepEqual((await resolveInvitationPrefill(f.args)).values, linked.values);
  assert.equal(f.writes(), 1);
  assert.equal(JSON.stringify(linked).includes('NEVER EXPOSE'), false);
  assert.equal(f.reads.some(r => r.columns.includes('password_hash') || r.columns === '*'), false);
});

test('confirmation rejects missing, wrong-tenant, wrong-recipient and inactive member/grant identities', async () => {
  const f = fixture();
  for (const sessionMember of [null, { ...f.rows.member[0], tenant_id: 'other' },
    { ...f.rows.member[0], email: 'booker@test.org' }, { ...f.rows.member[0], login_enabled: false }]) {
    await assert.rejects(resolveInvitationPrefill({ ...f.args, confirm: true, sessionMember }), { status: 403 });
  }
  await assert.rejects(resolveInvitationPrefill({ ...f.args, invited: { ...f.args.invited, status: 'completed' }, confirm: true, sessionMember: f.rows.member[0] }), { status: 403 });
  assert.equal(f.writes(), 0);
});

test('SQL recheck rejection is surfaced as 403 and never falls back to a direct association write', async () => {
  const f = fixture();
  let rpcArgs;
  f.args.invited.booking.survey_invitation_revision = 12;
  f.args.invited.grant.survey_invitation_revision = 8;
  f.rows.member[0].survey_invitation_revision = 7;
  f.args.db.rpc = async (_name, args) => {
    rpcArgs = args;
    return { error: { code: '42501' } };
  };
  await assert.rejects(resolveInvitationPrefill({ ...f.args, confirm: true, sessionMember: f.rows.member[0] }), { status: 403 });
  assert.equal(rpcArgs.p_booking_revision, 12);
  assert.equal(rpcArgs.p_entitlement_revision, 8);
  assert.equal(rpcArgs.p_member_revision, 7);
  assert.equal(f.writes(), 0);
  assert.deepEqual(f.rows.survey_invitation_attendee, []);
});

test('booking edits, recipient edits, cross-tenant records and member revocation fail closed', async () => {
  for (const change of [
    f => { f.args.invited.booking.attendee_first_name = 'Different'; },
    f => { f.args.invited.grant.recipient_email = 'different@test.org'; },
    f => { f.rows.member[0].tenant_id = 'other'; },
    f => { f.rows.member[0].email = 'different@test.org'; },
    f => { f.rows.member[0].membership_paused = true; },
  ]) {
    const f = fixture();
    await resolveInvitationPrefill({ ...f.args, confirm: true, sessionMember: f.rows.member[0] });
    change(f);
    assert.equal((await resolveInvitationPrefill(f.args)).association.status, 'unlinked');
  }
  const f = fixture();
  f.rows.organization[0].tenant_id = 'other';
  f.rows.organization_group[0].tenant_id = 'other';
  const result = await resolveInvitationPrefill({ ...f.args, confirm: true, sessionMember: f.rows.member[0] });
  assert.equal(result.values.org, undefined);
  assert.equal(result.values.relationship, undefined);
  assert.equal(result.values.group, undefined);
});

test('fingerprint ordering stable; booking data and enrichment never leak through anonymous answers', () => {
  assert.equal(invitationBookingFingerprint({ a: 1, b: 2 }), invitationBookingFingerprint({ b: 2, a: 1 }));
  const inputs = [...fields, { id: 'rel', relationship_config: { member: true } }, { id: 'feedback' }];
  assert.deepEqual(redactIdentityAnswers(inputs, Object.fromEntries(inputs.map(f => [f.id, 'answer']))).data, { feedback: 'answer' });
});

test('migration service-only association, no backfill, permanent invalidation and pinned offline dry-run', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261125_survey_invitation_attendee.sql', import.meta.url), 'utf8');
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public.survey_invitation_attendee FROM PUBLIC, anon, authenticated/);
  for (const table of ['booking', 'complex_event_booking', 'member', 'certificate_survey_entitlement']) assert.ok(sql.includes(`UPDATE OR DELETE ON public.${table}`));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /p_entitlement_revision/);
  const result = spawnSync(process.execPath, ['scripts/apply-survey-invitation-attendee.mjs'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).writesPerformed, false);
  assert.equal(JSON.parse(result.stdout).destinationProject, 'lvmzliemqnieeoruhkik');
});

test('real assignment endpoint POST requires explicit matching session; GET uses immutable snapshot and durable link', async () => {
  const f = fixture();
  const token = 'a'.repeat(43);
  f.rows.event_survey_assignment = [{ id: 'assignment', token: 'link', tenant_id: 'tenant', form_id: 'form',
    event_type: 'event', event_id: 'event', status: 'active', access_mode: 'authenticated' }];
  f.rows.booking = [{ ...f.args.invited.booking, tenant_id: 'tenant', event_id: 'event', status: 'confirmed' }];
  f.rows.certificate_survey_entitlement = [{ id: 'grant', tenant_id: 'tenant', assignment_id: 'assignment',
    recipient_email: 'a@test.org', booking_source: 'standard', booking_id: 'booking', expires_at: '2099-01-01' }];
  f.rows.certificate_survey_credential = [{ entitlement_id: 'grant', token_hash: certificateSurveyTokenHash(token),
    delivery_id: 'delivery', expires_at: '2099-01-01' }];
  f.rows.attendee_cpd_certificate_delivery = [{ id: 'delivery', tenant_id: 'tenant', booking_source: 'standard', booking_id: 'booking', status: 'accepted' }];
  f.rows.form = [{ id: 'form', tenant_id: 'tenant', is_active: true, form_type: 'survey',
    fields: [{ id: 'unpublished', prefill_field: 'member:email' }], survey_settings: { status: 'published', current_version: 1 } }];
  f.rows.survey_version = [{ form_id: 'form', tenant_id: 'tenant', version_number: 1, fields,
    survey_settings: f.args.settings }];
  f.rows.event = [{ id: 'event', tenant_id: 'tenant' }];
  const invoke = async (method, member, body = { action: 'confirm_attendee' }, grant = token) => {
    const result = {};
    const res = { setHeader() {}, status(code) { result.status = code; return res; },
      json(value) { result.body = value; return res; } };
    await handler({ method, query: { token: 'link' }, body, headers: { 'x-certificate-survey-grant': grant } }, res,
      { supabase: f.args.db, resolveTenant: async () => ({ id: 'tenant' }), getSessionMember: async () => member,
        getSession: async () => member ? {} : null });
    return result;
  };
  assert.equal((await invoke('POST', null)).status, 403);
  assert.equal((await invoke('POST', f.rows.member[0], { action: 'confirm_attendee', member_id: 'purchaser' })).status, 400);
  assert.equal((await invoke('POST', { ...f.rows.member[0], tenant_id: 'foreign' })).status, 403);
  assert.equal((await invoke('POST', f.rows.member[0], undefined, 'bad')).status, 403);
  assert.equal(f.writes(), 0);
  const confirmed = await invoke('POST', f.rows.member[0]);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.invitation_prefill.association.status, 'linked');
  assert.equal(confirmed.body.invitation_prefill.values.unpublished, undefined);
  const subsequent = await invoke('GET', null);
  assert.deepEqual(subsequent.body.invitation_prefill.values, confirmed.body.invitation_prefill.values);
  assert.equal(f.writes(), 1);
  f.rows.certificate_survey_entitlement[0].revoked_at = new Date().toISOString();
  assert.equal((await invoke('GET', null)).status, 403);
});