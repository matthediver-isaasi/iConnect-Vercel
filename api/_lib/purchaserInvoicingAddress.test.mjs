import test from 'node:test';
import assert from 'node:assert/strict';
import { savePurchaserInvoicingAddress, purchaserMemberId } from './purchaserInvoicingAddress.js';
import { completePublicTicketMembers } from './publicTicketMemberPurchase.js';

const details = {
  email: 'buyer@example.com', first_name: 'Ana', last_name: 'Buyer', organization: '',
  invoicing_address_line1: ' 1 High Street ', invoicing_address_line2: '', invoicing_city: 'Leeds',
  invoicing_region: '', invoicing_postal_code: 'LS1 1AA', invoicing_country: 'United Kingdom',
};
const silent = { error() {} };

function store({ insertError = null, existing = null, patchError = null, links = [] } = {}) {
  const calls = { inserts: [], patches: [] };
  return {
    calls,
    from(table) {
      const query = {
        insert(row) { calls.inserts.push({ table, row }); return Promise.resolve({ error: insertError }); },
        select() { return this; }, eq() { return this; },
        limit() { return Promise.resolve({ data: links, error: null }); },
        maybeSingle() { return Promise.resolve({ data: existing, error: null }); },
        update() { return this; }, in() { return Promise.resolve({ error: null }); },
      };
      return query;
    },
    rpc(name, args) {
      if (name === 'provision_public_ticket_members') return Promise.resolve({ data: { state: 'completed', created: 1 }, error: null });
      calls.patches.push({ name, args });
      return Promise.resolve({ error: patchError });
    },
  };
}

test('saves the checkout invoice address to the member core invoicing fields', async () => {
  const db = store();
  assert.deepEqual(await savePurchaserInvoicingAddress({ db, tenantId: 't', memberId: 'm', details, logger: silent }), { state: 'saved' });
  assert.deepEqual(db.calls.inserts[0], { table: 'invoicing_address_private', row: {
    tenant_id: 't', owner_type: 'member', owner_id: 'm', invoicing_address_line1: '1 High Street',
    invoicing_address_line2: null, invoicing_city: 'Leeds', invoicing_region: null,
    invoicing_postal_code: 'LS1 1AA', invoicing_country: 'United Kingdom',
  } });
});

test('never overwrites an address already saved on the member', async () => {
  const db = store({ insertError: { code: '23505' }, existing: { invoicing_address_line1: 'Old Road' } });
  assert.equal((await savePurchaserInvoicingAddress({ db, tenantId: 't', memberId: 'm', details, logger: silent })).state, 'kept_existing');
  assert.equal(db.calls.patches.length, 0);
});

test('fills an existing but empty address row', async () => {
  const db = store({ insertError: { code: '23505' }, existing: { invoicing_address_line1: null } });
  assert.equal((await savePurchaserInvoicingAddress({ db, tenantId: 't', memberId: 'm', details, logger: silent })).state, 'saved');
  assert.equal(db.calls.patches[0].name, 'patch_private_invoicing_address');
  assert.equal(db.calls.patches[0].args.p_address.invoicing_city, 'Leeds');
});

test('skips missing addresses and reports storage failures without throwing', async () => {
  assert.equal((await savePurchaserInvoicingAddress({ db: store(), tenantId: 't', memberId: 'm', details: { email: 'x' } })).state, 'no_address');
  const failing = store({ insertError: { code: '42501' } });
  assert.equal((await savePurchaserInvoicingAddress({ db: failing, tenantId: 't', memberId: 'm', details, logger: silent })).state, 'retryable');
});

test('identifies only the purchaser link created by provisioning', async () => {
  const db = store({ links: [
    { member_id: 'attendee', participation: [{ kind: 'attendee', index: 0 }] },
    { member_id: 'buyer', participation: [{ kind: 'purchaser' }] },
  ] });
  assert.equal(await purchaserMemberId(db, 'p'), 'buyer');
  assert.equal(await purchaserMemberId(store({ links: [] }), 'p'), null);
});

test('Invoice / PO provisioning stores the purchaser address on the new member', async () => {
  const db = store({ links: [{ member_id: 'buyer', participation: [{ kind: 'purchaser' }] }] });
  const purchase = { id: 'p', snapshot: { guest_accounts: true } };
  const result = await completePublicTicketMembers({ db, purchase, tenantId: 't', bookingIds: ['b'],
    paymentStatus: 'unpaid', purchaserInvoicingDetails: details });
  assert.equal(result.state, 'completed');
  assert.equal(db.calls.inserts.find(call => call.table === 'invoicing_address_private')?.row.owner_id, 'buyer');
});

test('card and free provisioning do not copy addresses', async () => {
  const db = store({ links: [{ member_id: 'buyer', participation: [{ kind: 'purchaser' }] }] });
  await completePublicTicketMembers({ db, purchase: { id: 'p', snapshot: {} }, tenantId: 't', bookingIds: ['b'], paymentStatus: 'paid' });
  assert.equal(db.calls.inserts.length, 0);
});
