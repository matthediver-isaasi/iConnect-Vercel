// Owner-authorised recipient/address correction; never create another invoice or send email.
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';
const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const memberId = '6b2e1a8d-c099-4b77-be98-183ef94765d5';
const orgId = '027807b4-8414-4d81-8619-f4b33d1120c0';
const invoiceId = 'c9d661f0-4f78-4068-80e2-72ca169d530e';
const sql = await connectDestination();
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
const { xeroRateLimitedFetch } = await import('../api/_lib/xeroRateLimit.js');
try {
  const { rows } = await sql.query(`select o.id,o.name from member m join organization o
    on o.id=m.organization_id and o.tenant_id=m.tenant_id where m.id=$1 and m.tenant_id=$2`, [memberId, tenantId]);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, orgId);
  const org = rows[0];
  const fields = (await sql.query(`select f.name,v.value from organization_preference_value v
    join preference_field f on f.id=v.field_id where v.organization_id=$1 and f.tenant_id=$2
    and f.name=any($3::text[])`, [orgId, tenantId, ['org_address_line_1','org_address_line_2','org_town_city','org_county']])).rows;
  const names = ['org_address_line_1','org_address_line_2','org_town_city','org_county'];
  const address = { AddressType: 'POBOX' };
  names.forEach((name, index) => {
    const matches = fields.filter(f => f.name === name);
    assert.equal(matches.length, 1); assert.ok(matches[0].value?.trim());
    address[`AddressLine${index + 1}`] = matches[0].value.trim();
  });
  const auth = await getValidXeroAccessToken(tenantId);
  assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
  async function request(path, body, key) {
    const r = await xeroRateLimitedFetch(`https://api.xero.com/api.xro/2.0/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId,
        Accept: 'application/json', 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000),
    });
    assert.equal(r.status, 200, `Xero request failed (${r.status})`);
    const data = await r.json();
    for (const item of [...(data.Invoices || []), ...(data.Contacts || [])]) assert.ok(!item.HasErrors && !item.HasValidationErrors);
    return data;
  }
  const before = (await request(`Invoices/${invoiceId}`)).Invoices[0];
  assert.equal(before.InvoiceNumber, 'INV-9743'); assert.equal(before.Reference, 'TBC');
  assert.equal(before.Total, 156); assert.equal(before.AmountPaid, 0); assert.equal(before.Status, 'AUTHORISED');
  assert.equal(before.Payments?.length || 0, 0); assert.equal(before.CreditNotes?.length || 0, 0);
  const contactNumber = `iconnect-org-${orgId}`;
  const search = await request(`Contacts?where=${encodeURIComponent(`Name==${JSON.stringify(org.name)}`)}`);
  assert.ok(search.Contacts.length <= 1, 'Ambiguous organisation contacts');
  let contact = search.Contacts[0];
  if (contact) {
    assert.equal(contact.ContactNumber, contactNumber, 'Existing contact needs identity review');
    assert.equal(contact.ContactStatus, 'ACTIVE');
  } else {
    assert.equal(before.Contact.ContactID, '234faa51-72dc-422a-ae7d-870558120e7d');
    contact = (await request('Contacts', { Contacts: [{ Name: org.name, ContactNumber: contactNumber, Addresses: [address] }] },
      'inv-9743-organisation-contact-v1')).Contacts[0];
  }
  assert.ok(contact.ContactID);
  const saved = (await request(`Contacts/${contact.ContactID}`)).Contacts[0];
  const savedAddress = saved.Addresses.find(a => a.AddressType === 'POBOX');
  for (const [key,value] of Object.entries(address)) assert.equal(savedAddress[key], value);
  if (before.Contact.ContactID !== contact.ContactID) {
    assert.equal(before.Contact.ContactID, '234faa51-72dc-422a-ae7d-870558120e7d');
    await request(`Invoices/${invoiceId}`, { Invoices: [{ InvoiceID: invoiceId, Contact: { ContactID: contact.ContactID } }] },
      'inv-9743-organisation-recipient-v1');
  }
  const after = (await request(`Invoices/${invoiceId}`)).Invoices[0];
  for (const key of ['InvoiceID','InvoiceNumber','Reference','Total','SubTotal','TotalTax','CurrencyCode','AmountPaid',
    'AmountDue','AmountCredited','Status','LineItems','Payments','CreditNotes','Date','DueDate','SentToContact']) {
    assert.deepEqual(after[key], before[key], `Unexpected change to ${key}`);
  }
  assert.equal(after.Contact.ContactID, contact.ContactID);
  console.log(JSON.stringify({ invoice: after.InvoiceNumber, organisation: org.name, reference: after.Reference,
    total: after.Total, recipientUpdated: true, addressVerified: true, billingEmailSupplied: false,
    invoicesCreated: 0, emailsSent: 0, paymentsCreated: 0 }));
} finally { await sql.end(); }
