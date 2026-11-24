import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePrincipal, enrichOpportunities, loadOpportunityAccess } from './opportunityService.js';
import { resolveSalesTenantUser } from './salesPrincipals.js';
import { salesPrincipalFixture, unifiedContext } from './salesPrincipals.fixture.mjs';
import { quoteSenderOptions, resolveQuoteSender } from './salesQuoteSenders.js';
import { readFile } from 'node:fs/promises';
import { createOpportunitiesHandler } from '../opportunities/index.js';
import { salesResponse } from './salesPrincipals.fixture.mjs';
import { sessionUnavailable } from './sessionAvailability.js';

test('the actual session resolver emits the unified ID that Sales must accept as tenant_user', async () => {
  const db = salesPrincipalFixture();
  assert.equal(db.rows.tenant_user.some(row => row.id === 'identity'), false);
  const source = await readFile(new URL('./session.js', import.meta.url), 'utf8');
  const readSessionSource = source.slice(source.indexOf('async function readSessionTenantUser('),
    source.indexOf('export async function invalidateMemberSessions('));
  const readSession = new Function('supabase', 'SESSION_NOT_PROVIDED', 'sessionUnavailable', 'console',
    `${readSessionSource}; return readSessionTenantUser;`)(db, Symbol(), sessionUnavailable,
    { log() {}, warn() {}, error() {} });
  const user = await readSession({}, { id: 'fixture-session', data: {
    userType: 'tenant_user', tenantUserId: 'identity', identityId: 'identity', tenantId: 'tenant-a',
  } });
  assert.equal(user.id, 'identity');
  assert.equal(user._isUnifiedIdentity, true);
  const res = salesResponse();
  await createOpportunitiesHandler({ db, getTenantContext: async () => ({
    isAuthenticated: true, tenantId: user._sessionTenantId, tenantUserId: user.id,
  }) })({ method: 'POST', body: { name: 'Sale', organizationId: 'org', stageId: 'stage', contactId: 'contact' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.owner_id, user.id);
  assert.equal(res.body.primary_contact_id, 'contact');
});

test('Sales resolves both staff ID forms with session-compatible duplicate membership authority', async () => {
  const db = salesPrincipalFixture();
  for (const id of ['legacy', 'identity', 'membership-owner', 'role-owner']) {
    assert.equal((await resolveSalesTenantUser(db, 'tenant-a', id)).id, id);
    await validatePrincipal(db, 'tenant-a', { kind: 'tenant_user', id });
  }
  await validatePrincipal(db, 'tenant-a', { kind: 'member', id: 'member-user' });
  for (const id of ['foreign', 'inactive', 'ordinary', 'absent', 'missing-identity', 'missing']) {
    await assert.rejects(validatePrincipal(db, 'tenant-a', { kind: 'tenant_user', id }), { status: 404 });
  }
  await assert.rejects(validatePrincipal(db, 'tenant-b', { kind: 'tenant_user', id: 'identity' }), { status: 404 });
  await assert.rejects(validatePrincipal(db, 'tenant-a', { kind: 'tenant_identity', id: 'identity' }), { status: 400 });
});

test('database errors never become missing users or fallback authority', async () => {
  for (const table of ['tenant_user', 'tenant_membership', 'tenant_identity']) {
    const db = salesPrincipalFixture();
    const failure = new Error(`${table} unavailable`);
    db.failures.set(table, failure);
    await assert.rejects(validatePrincipal(db, 'tenant-a', { kind: 'tenant_user', id: 'identity' }),
      error => error === failure);
  }
});

test('identity ownership remains readable and named without changing the customer contact', async () => {
  const db = salesPrincipalFixture();
  db.rows.opportunity.push({ id: 'opp', tenant_id: 'tenant-a', organization_id: 'org', stage_id: 'stage',
    owner_kind: 'tenant_user', owner_id: 'identity', primary_contact_id: 'contact' });
  db.rows.opportunity_contact_role.push({ tenant_id: 'tenant-a', opportunity_id: 'opp',
    member_id: 'contact', is_primary: true, role: 'Primary contact' });
  const access = await loadOpportunityAccess(db, unifiedContext, 'opp', async () => false);
  assert.equal(access.permissions.canManage, true);
  const [row] = await enrichOpportunities(db, 'tenant-a', [access.opportunity]);
  assert.deepEqual(row.owner, { id: 'identity', kind: 'tenant_user', name: 'Unified Admin', email: 'admin@example.test' });
  assert.equal(row.primaryContact.id, 'contact');
});

test('identity sender resolution retains eligibility, actor matching and final envelope rules', async () => {
  const db = salesPrincipalFixture();
  db.rows.opportunity.push({ id: 'opp', tenant_id: 'tenant-a', owner_kind: 'tenant_user', owner_id: 'identity' });
  db.rows.opportunity_collaborator.push(...['foreign', 'inactive', 'ordinary', 'absent'].map(id =>
    ({ tenant_id: 'tenant-a', opportunity_id: 'opp', principal_kind: 'tenant_user', principal_id: id })));
  const actor = { tenantId: 'tenant-a', actorType: 'tenant_user', actorId: 'identity' };
  const quote = { opportunity_id: 'opp' };
  const options = await quoteSenderOptions(db, quote, actor);
  assert.deepEqual(options.items.map(row => row.key), ['tenant_user:identity']);
  assert.equal(options.defaultSenderKey, 'tenant_user:identity');
  const sender = await resolveQuoteSender(db, quote, actor, undefined, {
    getTenantEmailConfig: async () => ({ fromEmail: 'sales@example.test' }),
  });
  assert.equal(sender.from, '"Unified Admin" <sales@example.test>');
  assert.equal(sender.replyTo, 'admin@example.test');
  assert.equal((await quoteSenderOptions(db, quote, { ...actor, actorId: 'outsider' })).defaultSenderKey, null);
  await assert.rejects(resolveQuoteSender(db, quote, actor, 'tenant_user:foreign'), /Select a current/);
});

test('qualified historical identity collaborators remain senders but customer contacts do not', async () => {
  const db = salesPrincipalFixture();
  db.rows.opportunity.push({ id: 'opp', tenant_id: 'tenant-a', owner_kind: 'tenant_user', owner_id: 'identity' });
  db.rows.opportunity_collaborator.push(
    { tenant_id: 'tenant-a', opportunity_id: 'opp', principal_kind: 'tenant_user', principal_id: 'membership-owner' },
    { tenant_id: 'tenant-a', opportunity_id: 'opp', principal_kind: 'member', principal_id: 'contact' });
  const actor = { tenantId: 'tenant-a', actorType: 'tenant_user', actorId: 'membership-owner' };
  const result = await quoteSenderOptions(db, { opportunity_id: 'opp' }, actor);
  assert.deepEqual(result.items.map(row => row.key), ['tenant_user:identity', 'tenant_user:membership-owner']);
  assert.equal(result.defaultSenderKey, 'tenant_user:membership-owner');
  db.rows.tenant_membership.find(row => row.identity_id === 'membership-owner').status = 'inactive';
  const revoked = await quoteSenderOptions(db, { opportunity_id: 'opp' }, actor);
  assert.deepEqual(revoked.items.map(row => row.key), ['tenant_user:identity']);
  assert.equal(revoked.defaultSenderKey, null);
});

test('owner enrichment and sender discovery propagate identity lookup failures', async () => {
  for (const table of ['tenant_user', 'tenant_membership', 'tenant_identity']) {
    const db = salesPrincipalFixture();
    const opportunity = { id: 'opp', tenant_id: 'tenant-a', organization_id: 'org', stage_id: 'stage',
      owner_kind: 'tenant_user', owner_id: 'identity' };
    db.rows.opportunity.push(opportunity);
    const failure = new Error(`${table} unavailable`);
    db.failures.set(table, failure);
    await assert.rejects(enrichOpportunities(db, 'tenant-a', [opportunity]), error => error === failure);
    await assert.rejects(quoteSenderOptions(db, { opportunity_id: 'opp' },
      { tenantId: 'tenant-a', actorType: 'tenant_user', actorId: 'identity' }), error => error === failure);
  }
});
