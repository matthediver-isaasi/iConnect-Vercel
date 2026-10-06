import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOwnBookingHistoryRead, scopeOwnBookingHistory } from './ownBookingHistory.js';

const ctx = { isAuthenticated: true, memberId: 'self', effectiveTenantId: 'tenant', organizationId: null };

test('organisation-less members may GET only an exact self-member booking filter', () => {
  for (const member_id of ['self', { eq: 'self' }]) {
    assert.equal(isOwnBookingHistoryRead('GET', 'Booking', ctx, { member_id }), true);
  }
  for (const filter of [null, {}, { member_id: 'other' }, { member_id: ['self'] },
    { member_id: { in: ['self'] } }, { member_id: { ilike: '%' } },
    { member_id: { eq: 'self', in: ['other'] } }, { attendee_email: 'person@example.invalid' }]) {
    assert.equal(isOwnBookingHistoryRead('GET', 'Booking', ctx, filter), false);
  }
});

test('exception cannot authorize writes, other entities, absent/foreign sessions, or organisation-wide requests', () => {
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    assert.equal(isOwnBookingHistoryRead(method, 'Booking', ctx, { member_id: 'self' }), false);
  }
  assert.equal(isOwnBookingHistoryRead('GET', 'TrainingFundTransaction', ctx, { member_id: 'self' }), false);
  for (const override of [{ isAuthenticated: false }, { tenantMismatch: true },
    { memberId: null }, { effectiveTenantId: null }, { organizationId: 'org' }]) {
    assert.equal(isOwnBookingHistoryRead('GET', 'Booking', { ...ctx, ...override }, { member_id: 'self' }), false);
  }
});

test('server scope intersects both tenant and member independently of arbitrary client filters', () => {
  let rows = [
    { id: 'own', tenant_id: 'tenant', member_id: 'self', organization_id: null },
    { id: 'other', tenant_id: 'tenant', member_id: 'other', organization_id: null },
    { id: 'foreign', tenant_id: 'foreign', member_id: 'self', organization_id: null },
  ];
  const query = { eq(key, value) { rows = rows.filter(r => r[key] === value); return query; } };
  assert.equal(scopeOwnBookingHistory(query, ctx), query);
  assert.deepEqual(rows.map(r => r.id), ['own']);
  assert.throws(() => scopeOwnBookingHistory(query, { memberId: 'self' }), /Invalid member history context/);
});

test('entity route bypasses only the organisation gate and enforces self scope ahead of tenant-wide access', () => {
  const source = readFileSync(new URL('../entities/[entity]/index.js', import.meta.url), 'utf8');
  assert.match(source, /tenantCtx\.ownBookingHistoryRead = isOwnBookingHistoryRead\(req\.method, entity, tenantCtx, parsedFilter\)/);
  assert.match(source, /tenantScope === TENANT_SCOPE\.ORGANIZATION[^\n]+!tenantCtx\.ownBookingHistoryRead/);
  assert.match(source, /if \(tenantCtx\.ownBookingHistoryRead\) \{\s*query = scopeOwnBookingHistory\(query, tenantCtx\);\s*\} else if \(tenantCtx\.allowsTenantWideAccess\)/);
  const history = readFileSync(new URL('../../client/src/pages/History.jsx', import.meta.url), 'utf8');
  assert.match(history, /hasOrg \? \{ organization_id: organizationInfo\.id \} : \{ member_id: memberInfo\.id \}/);
});
