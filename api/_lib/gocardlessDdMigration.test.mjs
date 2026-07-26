// GoCardless Phase 5 — migration invite + funnel tests.
// Run: node --test api/_lib/gocardlessDdMigration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMigrationInvite,
  MIGRATION_INVITE_INVALID_MESSAGES,
  migrationFunnelStage,
} from './gocardlessDdMigration.js';

const now = new Date('2026-07-26T12:00:00Z');
const future = new Date(now.getTime() + 7 * 86_400_000).toISOString();
const past = new Date(now.getTime() - 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// validateMigrationInvite — token security model (single-use / supersede / expiry)

test('live invite is valid', () => {
  assert.deepEqual(validateMigrationInvite({ status: 'invited', expires_at: future }, now), { valid: true });
});

test('missing invite -> not_found', () => {
  assert.equal(validateMigrationInvite(null, now).reason, 'not_found');
});

test('every terminal status is rejected with its own reason', () => {
  for (const status of ['revoked', 'superseded', 'declined', 'accepted', 'expired']) {
    const r = validateMigrationInvite({ status, expires_at: future }, now);
    assert.equal(r.valid, false, status);
    assert.equal(r.reason, status);
    assert.ok(MIGRATION_INVITE_INVALID_MESSAGES[r.reason], `message exists for ${status}`);
  }
});

test('past expiry rejects even when status is still invited', () => {
  const r = validateMigrationInvite({ status: 'invited', expires_at: past }, now);
  assert.deepEqual(r, { valid: false, reason: 'expired' });
});

test('expiry boundary: exactly-now is expired', () => {
  const r = validateMigrationInvite({ status: 'invited', expires_at: now.toISOString() }, now);
  assert.equal(r.reason, 'expired');
});

// ---------------------------------------------------------------------------
// migrationFunnelStage — conversion funnel derivation

test('invited + live -> invited; invited + past expiry -> expired', () => {
  assert.equal(migrationFunnelStage({ status: 'invited', expires_at: future }, {}, now), 'invited');
  assert.equal(migrationFunnelStage({ status: 'invited', expires_at: past }, {}, now), 'expired');
});

test('terminal invite statuses map directly', () => {
  for (const status of ['declined', 'revoked', 'superseded']) {
    assert.equal(migrationFunnelStage({ status }, {}, now), status);
  }
  assert.equal(migrationFunnelStage({ status: 'expired' }, {}, now), 'expired');
});

test('accepted without mandate -> accepted', () => {
  assert.equal(migrationFunnelStage({ status: 'accepted' }, { agreement: { gocardless_mandate_id: null } }, now), 'accepted');
});

test('accepted with mandate but no subscription -> mandate_active', () => {
  const stage = migrationFunnelStage(
    { status: 'accepted' },
    { agreement: { gocardless_mandate_id: 'MD1' }, plan: null },
    now,
  );
  assert.equal(stage, 'mandate_active');
});

test('accepted with live subscription -> subscription_active', () => {
  const stage = migrationFunnelStage(
    { status: 'accepted' },
    { agreement: { gocardless_mandate_id: 'MD1' }, plan: { status: 'active', gocardless_subscription_id: 'SB1' } },
    now,
  );
  assert.equal(stage, 'subscription_active');
});

test('accepted with cancelled/failed plan -> failed', () => {
  for (const status of ['cancelled', 'failed']) {
    const stage = migrationFunnelStage(
      { status: 'accepted' },
      { agreement: { gocardless_mandate_id: 'MD1' }, plan: { status, gocardless_subscription_id: 'SB1' } },
      now,
    );
    assert.equal(stage, 'failed', status);
  }
});

test('null invite -> null', () => {
  assert.equal(migrationFunnelStage(null, {}, now), null);
});
