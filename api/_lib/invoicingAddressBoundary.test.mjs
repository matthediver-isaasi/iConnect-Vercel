import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateInvoicingAddressWrite, projectInvoicingAddressResponse, enforceInvoicingAddressBoundary } from './invoicingAddressBoundary.js';
import { INVOICING_ADDRESS_KEYS } from '../../shared/invoicingAddress.js';
const patch = Object.fromEntries(INVOICING_ADDRESS_KEYS.map(key => [key, 'private']));
const response = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('virtual fields never reach generic owner persistence, even for admins or bulk wrappers', () => {
  for (const entity of ['Member', 'Organization', 'organization_group']) {
    for (const body of [patch, [patch], { records: [patch] }, { data: { items: [patch] } }]) {
      const result = validateInvoicingAddressWrite(entity, body);
      assert.equal(result.status, 400);
      assert.match(result.error, /\/api\/invoicing-address/);
    }
    assert.equal(validateInvoicingAddressWrite(entity, { name: 'ordinary edit' }), null);
  }
});

test('generic responses do not hydrate billing fields and redact any older-schema values recursively', () => {
  const input = { id: 'self', ...patch, data: { id: 'self', ...patch }, organization: { ...patch } };
  assert.deepEqual(projectInvoicingAddressResponse(input), { id: 'self', data: { id: 'self' }, organization: {} });
  assert.deepEqual(projectInvoicingAddressResponse({ data: [input], count: 1 }), { data: [{ id: 'self', data: { id: 'self' }, organization: {} }], count: 1 });
  assert.equal(input.invoicing_city, 'private');
});

test('generic reads reject virtual field projections and writes reject before persistence without sidecar access', async () => {
  for (const req of [
    { method: 'PATCH', body: patch },
    { method: 'GET', query: { expand: 'alias:invoicing_city' } },
    { method: 'GET', query: { filter: '{"invoicing_city":"secret"}' } },
  ]) {
    const res = response();
    assert.equal(await enforceInvoicingAddressBoundary({ entity: 'Member', req, res }), true);
    assert.equal(res.statusCode, 400);
  }
  const res = response();
  assert.equal(await enforceInvoicingAddressBoundary({ entity: 'Organization', req: { method: 'PATCH', body: { name: 'ordinary' } }, res }), false);
  res.json({ id: 'org', ...patch });
  assert.deepEqual(res.body, { id: 'org' });
  const join = response();
  assert.equal(await enforceInvoicingAddressBoundary({ entity: 'Booking', req: { method: 'GET', query: { expand: '*,member(*)' } }, res: join }), false);
  join.json({ member: { ...patch } });
  assert.deepEqual(join.body, { member: {} });
});

test('alternate owner allowlists reject virtual writes and anonymization never writes nonexistent owner columns', () => {
  for (const file of ['../admin/organizations/[id].js', '../admin/members/[memberId]/index.js']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.\.\.INVOICING_ADDRESS_KEYS/);
    assert.match(source, /if \(writesAddress\).*\/api\/invoicing-address/);
  }
  const source = fs.readFileSync(new URL('./memberAnonymize.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /INVOICING_ADDRESS_KEYS/);
  for (const file of ['../entities/[entity]/index.js', '../entities/[entity]/[id].js']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /await enforceInvoicingAddressBoundary/);
    assert.doesNotMatch(source, /'[^']+': 'invoicing_address_private'/);
  }
});
