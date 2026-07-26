// GoCardless Phase 3 — DD invitation token/expiry/lifecycle tests (fake db).
// Run: node --test api/_lib/gocardlessDdInvitations.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  generateInviteToken,
  clampExpiryDays,
  computeExpiry,
  validateInvitation,
  createInvitation,
  markInvitationCompletedForAgreement,
  revokeInvitationsForAgreement,
  resolveInviteExpiryDays,
  DEFAULT_INVITE_EXPIRY_DAYS,
} from './gocardlessDdInvitations.js';
import { resolveDdEmailRecipients } from './gocardlessDdEmails.js';

// ---------------------------------------------------------------------------
// Minimal in-memory supabase-shaped fake (same shape as webhook processor tests)
// ---------------------------------------------------------------------------

function makeFakeDb(initial = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(initial)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }
  const ensure = (name) => (tables[name] ||= []);

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.op = null;
      this.payload = null;
      this._single = false;
    }
    select() { if (!this.op) this.op = 'select'; return this; }
    insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
    update(payload) { this.op = 'update'; this.payload = payload; return this; }
    eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
    order() { return this; }
    limit() { return this; }
    _matches() { return ensure(this.table).filter((r) => this.filters.every((f) => f(r))); }
    _run() {
      const rows = ensure(this.table);
      if (this.op === 'insert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const out = [];
        for (const p of list) {
          const row = { id: p.id || crypto.randomUUID(), ...p };
          rows.push(row);
          out.push({ ...row });
        }
        return { data: out, error: null };
      }
      if (this.op === 'update') {
        const matched = this._matches();
        for (const r of matched) Object.assign(r, this.payload);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      return { data: this._matches().map((r) => ({ ...r })), error: null };
    }
    single() {
      const { data, error } = this._run();
      return Promise.resolve({ data: data[0] || null, error: error || (data[0] ? null : { message: 'no rows' }) });
    }
    maybeSingle() {
      const { data, error } = this._run();
      return Promise.resolve({ data: data[0] || null, error });
    }
    then(resolve, reject) {
      try { resolve(this._run()); } catch (e) { reject(e); }
    }
  }

  return { tables, from(table) { return new Query(table); } };
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const AGREEMENT = '33333333-3333-3333-3333-333333333333';

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

test('generateInviteToken: 64-char hex, unique', () => {
  const a = generateInviteToken();
  const b = generateInviteToken();
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.match(b, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// Expiry clamping
// ---------------------------------------------------------------------------

test('clampExpiryDays: default on garbage, clamp 1-90', () => {
  assert.equal(clampExpiryDays(undefined), DEFAULT_INVITE_EXPIRY_DAYS);
  assert.equal(clampExpiryDays('abc'), DEFAULT_INVITE_EXPIRY_DAYS);
  assert.equal(clampExpiryDays(0), 1);
  assert.equal(clampExpiryDays(-5), 1);
  assert.equal(clampExpiryDays(7), 7);
  assert.equal(clampExpiryDays('14'), 14);
  assert.equal(clampExpiryDays(90), 90);
  assert.equal(clampExpiryDays(365), 90);
});

test('computeExpiry: adds clamped days to now', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assert.equal(computeExpiry(now, 7).toISOString(), '2026-01-08T00:00:00.000Z');
  assert.equal(computeExpiry(now, 1000).toISOString(), '2026-04-01T00:00:00.000Z'); // clamped to 90
});

test('resolveInviteExpiryDays: reads system_settings, clamps, defaults', async () => {
  const db = makeFakeDb({
    system_settings: [
      { tenant_id: TENANT, setting_key: 'dd_invite_expiry_days', setting_value: '200' },
    ],
  });
  assert.equal(await resolveInviteExpiryDays(TENANT, { db }), 90);
  assert.equal(await resolveInviteExpiryDays('other-tenant', { db }), DEFAULT_INVITE_EXPIRY_DAYS);
});

// ---------------------------------------------------------------------------
// validateInvitation
// ---------------------------------------------------------------------------

test('validateInvitation: reasons for each terminal state', () => {
  const now = new Date('2026-01-10T00:00:00Z');
  const future = '2026-01-20T00:00:00Z';
  assert.deepEqual(validateInvitation(null, now), { valid: false, reason: 'not_found' });
  assert.deepEqual(validateInvitation({ status: 'revoked', expires_at: future }, now), { valid: false, reason: 'revoked' });
  assert.deepEqual(validateInvitation({ status: 'superseded', expires_at: future }, now), { valid: false, reason: 'superseded' });
  assert.deepEqual(validateInvitation({ status: 'completed', expires_at: future }, now), { valid: false, reason: 'completed' });
  assert.deepEqual(validateInvitation({ status: 'pending', expires_at: '2026-01-05T00:00:00Z' }, now), { valid: false, reason: 'expired' });
  assert.deepEqual(validateInvitation({ status: 'pending', expires_at: null }, now), { valid: false, reason: 'expired' });
  assert.deepEqual(validateInvitation({ status: 'pending', expires_at: future }, now), { valid: true });
});

// ---------------------------------------------------------------------------
// createInvitation — supersede + fields
// ---------------------------------------------------------------------------

test('createInvitation: supersedes prior pending invites, lowercases email', async () => {
  const db = makeFakeDb({
    membership_dd_invitations: [
      { id: 'old-1', billing_agreement_id: AGREEMENT, status: 'pending', token: 'x' },
      { id: 'done-1', billing_agreement_id: AGREEMENT, status: 'completed', token: 'y' },
    ],
  });
  const row = await createInvitation({
    tenantId: TENANT, organizationId: ORG, billingAgreementId: AGREEMENT,
    invitedEmail: '  Billing@Example.COM ', invitedName: 'Billy Bill',
    expiryDays: 14, now: new Date('2026-01-01T00:00:00Z'), db,
  });
  assert.equal(row.invited_email, 'billing@example.com');
  assert.match(row.token, /^[a-f0-9]{64}$/);
  assert.equal(row.status, 'pending');
  assert.equal(row.expires_at, '2026-01-15T00:00:00.000Z');
  const old = db.tables.membership_dd_invitations.find((r) => r.id === 'old-1');
  assert.equal(old.status, 'superseded');
  const done = db.tables.membership_dd_invitations.find((r) => r.id === 'done-1');
  assert.equal(done.status, 'completed'); // untouched
});

test('createInvitation: requires core args', async () => {
  const db = makeFakeDb();
  await assert.rejects(() => createInvitation({ tenantId: TENANT, db }));
});

// ---------------------------------------------------------------------------
// Single-use + revoke
// ---------------------------------------------------------------------------

test('markInvitationCompletedForAgreement: only flips pending; idempotent', async () => {
  const db = makeFakeDb({
    membership_dd_invitations: [
      { id: 'p1', billing_agreement_id: AGREEMENT, status: 'pending' },
      { id: 'r1', billing_agreement_id: AGREEMENT, status: 'revoked' },
    ],
  });
  const first = await markInvitationCompletedForAgreement(AGREEMENT, { db });
  assert.equal(first.updated, true);
  assert.equal(db.tables.membership_dd_invitations.find((r) => r.id === 'p1').status, 'completed');
  assert.equal(db.tables.membership_dd_invitations.find((r) => r.id === 'r1').status, 'revoked');
  const again = await markInvitationCompletedForAgreement(AGREEMENT, { db });
  assert.equal(again.updated, false);
});

test('revokeInvitationsForAgreement: revokes pending only', async () => {
  const db = makeFakeDb({
    membership_dd_invitations: [
      { id: 'p1', billing_agreement_id: AGREEMENT, status: 'pending' },
      { id: 'c1', billing_agreement_id: AGREEMENT, status: 'completed' },
    ],
  });
  const res = await revokeInvitationsForAgreement(AGREEMENT, { db });
  assert.equal(res.updated, true);
  assert.equal(db.tables.membership_dd_invitations.find((r) => r.id === 'p1').status, 'revoked');
  assert.equal(db.tables.membership_dd_invitations.find((r) => r.id === 'c1').status, 'completed');
});

// ---------------------------------------------------------------------------
// Org email recipients
// ---------------------------------------------------------------------------

test('resolveDdEmailRecipients: org billing contact + primary contact, deduped', async () => {
  const db = makeFakeDb({
    member: [{ id: 'm1', email: 'prime@example.com', first_name: 'Pri' }],
  });
  const agreement = {
    organization_id: ORG,
    dd_payer: 'billing_contact',
    billing_contact_email: 'billing@example.com',
    billing_contact_name: 'Billy Bill',
    primary_contact_member_id: 'm1',
  };
  const { recipients } = await resolveDdEmailRecipients(agreement, { db });
  assert.deepEqual(recipients.map((r) => r.email).sort(), ['billing@example.com', 'prime@example.com']);
  assert.equal(recipients[0].firstName, 'Billy');

  // dedupe when billing contact == primary contact email
  const dup = { ...agreement, billing_contact_email: 'PRIME@example.com' };
  const { recipients: deduped } = await resolveDdEmailRecipients(dup, { db });
  assert.equal(deduped.length, 1);
});

test('resolveDdEmailRecipients: self-payer org falls back to primary contact only', async () => {
  const db = makeFakeDb({
    member: [{ id: 'm1', email: 'prime@example.com', first_name: 'Pri' }],
  });
  const { recipients } = await resolveDdEmailRecipients(
    { organization_id: ORG, dd_payer: 'self', primary_contact_member_id: 'm1' },
    { db }
  );
  assert.deepEqual(recipients, [{ email: 'prime@example.com', firstName: 'Pri' }]);
});
