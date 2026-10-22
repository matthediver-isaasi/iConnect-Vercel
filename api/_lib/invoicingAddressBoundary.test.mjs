import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateInvoicingAddressWrite, projectInvoicingAddressResponse, enforceInvoicingAddressBoundary,
} from './invoicingAddressBoundary.js';
import { INVOICING_ADDRESS_KEYS } from '../../shared/invoicingAddress.js';

const ctx = { isAuthenticated: true, memberId: 'self', tenantId: 'tenant' };
const patch = Object.fromEntries(INVOICING_ADDRESS_KEYS.map(key => [key, 'private']));

test('self-service can edit only its own member address, never organisation or group', () => {
  for (const entity of ['Organization', 'organization_group', 'organization-group']) {
    assert.equal(validateInvoicingAddressWrite(entity, patch, ctx, { id: 'self' }).status, 403);
    assert.equal(validateInvoicingAddressWrite(entity, patch, ctx, { id: 'self', isAdmin: true }), null);
  }
  assert.equal(validateInvoicingAddressWrite('Member', patch, ctx, { id: 'self' }), null);
  assert.equal(validateInvoicingAddressWrite('Member', patch, ctx, { id: 'other' }).status, 403);
  assert.equal(validateInvoicingAddressWrite('Member', patch, ctx).status, 403);
  assert.equal(validateInvoicingAddressWrite('Member', [patch], {}, { isAdmin: true }).status, 403);
  assert.equal(validateInvoicingAddressWrite('Member', patch, { ...ctx, tenantMismatch: true }, { isAdmin: true }).status, 403);
  assert.equal(validateInvoicingAddressWrite('Member', { invoicing_city: {} }, ctx, { id: 'self' }).status, 400);
  assert.equal(validateInvoicingAddressWrite('Organization', { name: 'Unchanged existing rules' }, ctx), null);
});

test('non-admin read and mutation responses redact other members and all joined billing owners', () => {
  const self = { id: 'self', ...patch, organization: { id: 'org', ...patch }, organization_group: { id: 'g', ...patch } };
  const other = { id: 'other', ...patch };
  const response = { data: [self, other], count: 2 };
  const safe = projectInvoicingAddressResponse(response, 'Member', ctx);
  assert.equal(safe.data[0].invoicing_city, 'private');
  assert.deepEqual(safe.data[0].organization, { id: 'org' });
  assert.deepEqual(safe.data[0].organization_group, { id: 'g' });
  assert.deepEqual(safe.data[1], { id: 'other' });
  assert.deepEqual(projectInvoicingAddressResponse(self, 'Member', {}), { id: 'self', organization: { id: 'org' }, organization_group: { id: 'g' } });
  assert.equal(projectInvoicingAddressResponse(response, 'Member', ctx, true), response);
  for (const entity of ['Organization', 'OrganizationGroup']) {
    assert.deepEqual(projectInvoicingAddressResponse({ id: 'self', ...patch }, entity, ctx), { id: 'self' });
  }
  assert.equal(other.invoicing_city, 'private');
  // A relation may be aliased "data", even with the same UUID as the member.
  // Never treat it as a counted-list envelope or inherit self-read rights.
  const aliasedJoin = { id: 'self', ...patch, data: { id: 'self', ...patch } };
  assert.deepEqual(projectInvoicingAddressResponse(aliasedJoin, 'Member', ctx).data, { id: 'self' });
  assert.deepEqual(projectInvoicingAddressResponse({ data: [aliasedJoin], count: 1 }, 'Member', ctx).data[0].data, { id: 'self' });
  assert.deepEqual(projectInvoicingAddressResponse({ id: 'self', ...patch }, 'Member', { ...ctx, tenantMismatch: true }), { id: 'self' });
});

test('route boundary rejects before writes and projects JSON responses', async () => {
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  const denied = await enforceInvoicingAddressBoundary({
    entity: 'Organization', req: { method: 'PATCH', body: patch }, res,
    context: ctx, hasAdminAccess: async () => false,
  });
  assert.equal(denied, true);
  assert.equal(res.statusCode, 403);
  assert.equal(await enforceInvoicingAddressBoundary({
    entity: 'OrganizationGroup', req: { method: 'GET' }, res,
    context: ctx, hasAdminAccess: async () => false,
  }), false);
  res.json({ id: 'g', ...patch });
  assert.deepEqual(res.body, { id: 'g' });
});

test('aliases, filters and joins from alternate generic entities cannot expose billing addresses', async () => {
  const makeResponse = () => ({
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  for (const query of [
    { expand: 'id,city_alias:invoicing_city' },
    { expand: 'id,member:member_id(city_alias:invoicing_city)' },
    { filter: '{"invoicing_city":"Private city"}' },
    { sort: 'invoicing_postal_code' },
  ]) {
    const res = makeResponse();
    assert.equal(await enforceInvoicingAddressBoundary({
      entity: query.expand?.includes('member:') ? 'Booking' : 'Member',
      req: { method: 'GET', query }, res, context: ctx, hasAdminAccess: async () => false,
    }), true);
    assert.equal(res.statusCode, 403);
  }
  const res = makeResponse();
  assert.equal(await enforceInvoicingAddressBoundary({
    entity: 'Booking', req: { method: 'GET', query: { expand: '*,person:member_id(*),payer:organization_id(*)' } },
    res, context: ctx, hasAdminAccess: async () => false,
  }), false);
  res.json({ id: 'booking', person: { id: 'self', ...patch }, payer: { id: 'org', ...patch } });
  assert.deepEqual(res.body, { id: 'booking', person: { id: 'self' }, payer: { id: 'org' } });
});

test('migration is additive/idempotent and does not touch transaction authority', () => {
  const sql = fs.readFileSync(new URL('../../supabase/migrations/202612310025_structured_invoicing_addresses.sql', import.meta.url), 'utf8');
  for (const entity of ['member', 'organization', 'organization_group']) assert.ok(sql.includes(`ALTER TABLE public.${entity}\n`));
  for (const key of INVOICING_ADDRESS_KEYS) assert.equal(sql.split(`ADD COLUMN IF NOT EXISTS ${key} text`).length - 1, 3);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|INSERT|DROP|GRANT)\b/i);
});

test('both generic routes, admin allowlists and self-service/public redaction are wired', () => {
  for (const file of ['../entities/[entity]/index.js', '../entities/[entity]/[id].js']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /await enforceInvoicingAddressBoundary/);
  }
  for (const file of ['../admin/organizations/[id].js', '../admin/members/[memberId]/index.js']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /\.\.\.INVOICING_ADDRESS_KEYS/);
    assert.match(source, /invoicingAddressError\(rawUpdates\)/);
  }
  const selfService = fs.readFileSync(new URL('../my-organization.js', import.meta.url), 'utf8');
  assert.match(selfService, /INVOICING_ADDRESS_KEYS\.some/);
  assert.match(selfService, /redactInvoicingAddress\(updatedOrg\)/);
  const publicOrg = fs.readFileSync(new URL('../public/organisation/[id].js', import.meta.url), 'utf8');
  assert.match(publicOrg, /redactInvoicingAddress\(publicOrg\)/);
  const anonymize = fs.readFileSync(new URL('./memberAnonymize.js', import.meta.url), 'utf8');
  assert.match(anonymize, /INVOICING_ADDRESS_KEYS\.map\(key => \[key, null\]\)/);
  const functions = fs.readFileSync(new URL('../functions/[functionName].js', import.meta.url), 'utf8');
  assert.match(functions, /member: redactInvoicingAddress\(magicLink\.member\)/);
  const adminMember = fs.readFileSync(new URL('../admin/members/[memberId]/index.js', import.meta.url), 'utf8');
  assert.match(adminMember, /memberQuery = memberQuery\.eq\('tenant_id', tenantId\)/);
  assert.match(adminMember, /tenantId \? member : redactInvoicingAddress\(member\)/);
});
