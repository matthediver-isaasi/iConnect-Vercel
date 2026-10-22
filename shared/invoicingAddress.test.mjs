import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INVOICING_ADDRESS_FIELDS, INVOICING_ADDRESS_KEYS, invoicingAddressError,
  resolveStoredInvoicingAddress, invoicingAddressToXero, invoicingAddressToQuickBooks,
  redactInvoicingAddress,
} from './invoicingAddress.js';

const address = {
  invoicing_address_line1: ' 1 Finance Road ',
  invoicing_address_line2: 'Suite 2',
  invoicing_city: 'London',
  invoicing_region: 'Greater London',
  invoicing_postal_code: 'SW1A 1AA',
  invoicing_country: 'United Kingdom',
};

test('six shared nullable text fields have immutable frontend metadata', () => {
  assert.equal(INVOICING_ADDRESS_FIELDS.length, 6);
  assert.deepEqual(INVOICING_ADDRESS_KEYS, Object.keys(address));
  assert.ok(INVOICING_ADDRESS_FIELDS.every(field => field.label && field.maxLength > 0 && Object.isFrozen(field)));
  assert.ok(INVOICING_ADDRESS_FIELDS.every(field => field.label.startsWith('Invoicing ')));
  assert.equal(INVOICING_ADDRESS_FIELDS.find(field => field.key === 'invoicing_country').maxLength, 50);
  assert.equal(invoicingAddressError({}), null);
  assert.equal(invoicingAddressError(Object.fromEntries(INVOICING_ADDRESS_KEYS.map(key => [key, null]))), null);
  for (const { key, maxLength } of INVOICING_ADDRESS_FIELDS) {
    for (const value of [42, {}, [], false, undefined, 'line\nbreak', '\u0000', 'a'.repeat(maxLength + 1)]) {
      assert.ok(invoicingAddressError({ [key]: value }), `${key}: ${JSON.stringify(value)}`);
    }
    assert.equal(invoicingAddressError({ [key]: 'a'.repeat(maxLength) }), null);
  }
});

test('resolution is independent, structured-first and does not mutate legacy data', () => {
  const input = { ...address, invoicing_address: 'Original legacy\nAddress' };
  const before = structuredClone(input);
  for (const entity of ['member', 'organization', 'organization_group']) {
    const resolved = resolveStoredInvoicingAddress(input, entity);
    assert.equal(resolved.source, 'structured');
    assert.equal(resolved.address.invoicing_address_line1, '1 Finance Road');
  }
  assert.deepEqual(input, before);
  const legacy = { invoicing_address: ' Original legacy\nAddress ', invoicing_city: ' ' };
  assert.deepEqual(resolveStoredInvoicingAddress(legacy, 'organization'), { source: 'legacy', address: legacy.invoicing_address });
  for (const entity of ['member', 'organization_group']) assert.equal(resolveStoredInvoicingAddress(legacy, entity), null);
  for (const partial of [{ invoicing_city: 'London' }, { invoicing_postal_code: 'SW1A 1AA' }, { invoicing_address_line1: ' ', invoicing_country: 'United Kingdom' }]) {
    for (const entity of ['member', 'organization', 'organization_group']) {
      assert.equal(resolveStoredInvoicingAddress(partial, entity), null);
    }
    assert.deepEqual(resolveStoredInvoicingAddress({ ...partial, invoicing_address: 'Original complete legacy' }, 'organization'), {
      source: 'legacy', address: 'Original complete legacy',
    });
  }
  assert.equal(resolveStoredInvoicingAddress({ invoicing_address_line1: 'Usable first line' }, 'member').source, 'structured');
  assert.equal(resolveStoredInvoicingAddress(null, 'member'), null);
  assert.throws(() => resolveStoredInvoicingAddress(address, 'other'), /Unsupported/);
  assert.throws(() => resolveStoredInvoicingAddress({ invoicing_city: {} }, 'member'), /must be text/);
});

test('provider mappings share country name and region semantics without provider actions', () => {
  const resolved = resolveStoredInvoicingAddress(address, 'member');
  assert.deepEqual(invoicingAddressToXero(resolved), {
    AddressType: 'POBOX', AddressLine1: '1 Finance Road', AddressLine2: 'Suite 2',
    City: 'London', Region: 'Greater London', PostalCode: 'SW1A 1AA', Country: 'United Kingdom',
  });
  assert.deepEqual(invoicingAddressToQuickBooks(resolved), {
    Line1: '1 Finance Road', Line2: 'Suite 2', City: 'London',
    CountrySubDivisionCode: 'Greater London', PostalCode: 'SW1A 1AA', Country: 'United Kingdom',
  });
  assert.equal(invoicingAddressToXero(null), null);
  assert.equal(invoicingAddressToQuickBooks(null), null);
  const legacy = resolveStoredInvoicingAddress({ invoicing_address: 'Original\nText' }, 'organization');
  assert.deepEqual(invoicingAddressToXero(legacy), { AddressType: 'POBOX', AddressLine1: 'Original\nText' });
  assert.deepEqual(invoicingAddressToQuickBooks(legacy), { Line1: 'Original\nText' });
});

test('redaction removes every new field, not legacy data, and never mutates input', () => {
  const input = { ...address, id: 'org', invoicing_address: 'Legacy' };
  assert.deepEqual(redactInvoicingAddress(input), { id: 'org', invoicing_address: 'Legacy' });
  assert.equal(input.invoicing_city, 'London');
});
