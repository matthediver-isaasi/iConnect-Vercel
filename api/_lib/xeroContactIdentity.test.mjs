import test from 'node:test';
import assert from 'node:assert/strict';
import { findOrCreateXeroContact } from './xero.js';

function transport(contacts) {
  const calls = [];
  return {
    calls,
    async fetch(url, init = {}) {
      calls.push({ url, ...init });
      const body = init.method === 'POST' ? JSON.parse(init.body).Contacts : contacts;
      return new Response(JSON.stringify({ Contacts: body.map(contact => ({ ContactID: 'created', ...contact })) }),
        { headers: { 'content-type': 'application/json' } });
    },
  };
}

for (const contacts of [
  [{ ContactID: 'other-person', EmailAddress: 'someone-else@example.com' }],
  [{ ContactID: 'unknown-person' }],
  [{ ContactID: 'one', EmailAddress: 'ada@example.com' }, { ContactID: 'two', EmailAddress: 'ada@example.com' }],
  [{ ContactID: 'archived', EmailAddress: 'ada@example.com', ContactStatus: 'ARCHIVED' }],
]) {
  test(`Xero refuses ambiguous/name-only contact reuse without any mutation: ${JSON.stringify(contacts)}`, async () => {
    const request = transport(contacts);
    await assert.rejects(findOrCreateXeroContact('test-only', 'isolated-company',
      { name: 'Ada Lovelace', email: 'ada@example.com', address: '1 Example Road' }, request),
    /identity review required/);
    assert.equal(request.calls.length, 1);
    assert.equal(request.calls[0].method || 'GET', 'GET');
  });
}

test('Xero name-only caller cannot reuse a named contact even with matching display name', async () => {
  const request = transport([{ ContactID: 'other', Name: 'Same Name' }]);
  await assert.rejects(findOrCreateXeroContact('test-only', 'isolated-company', 'Same Name', request),
    /identity review required/);
  assert.equal(request.calls.length, 1);
});

test('Xero selects the unique matching identity, not the first namesake, and does not change its email', async () => {
  const request = transport([
    { ContactID: 'wrong-person', EmailAddress: 'other@example.com' },
    { ContactID: 'right-person', EmailAddress: 'Ada@Example.COM', ContactStatus: 'ACTIVE' },
  ]);
  assert.equal(await findOrCreateXeroContact('test-only', 'isolated-company',
    { name: 'Ada Lovelace', email: 'ada@example.com', address: '1 Example Road' }, request), 'right-person');
  const update = JSON.parse(request.calls[1].body).Contacts[0];
  assert.equal(update.ContactID, 'right-person');
  assert.equal(Object.hasOwn(update, 'EmailAddress'), false, 'existing contact email is never overwritten');
});

test('Xero creates a genuine new contact when there is no collision', async () => {
  const request = transport([]);
  assert.equal(await findOrCreateXeroContact('test-only', 'isolated-company',
    { name: 'Ada Lovelace', email: 'ada@example.com' }, request), 'created');
  assert.equal(request.calls.length, 2);
  assert.equal(JSON.parse(request.calls[1].body).Contacts[0].EmailAddress, 'ada@example.com');
});

for (const identity of [
  { name: 'Deleted Member', email: 'deleted_abc@deleted.local' },
  { name: 'Deleted Member', email: 'unrelated@example.com' },
  { name: 'Ada Lovelace', email: 'DELETED_abc@DELETED.LOCAL' },
  { name: '', email: 'ada@example.com' },
]) {
  test(`Xero blocks placeholder identity before even searching: ${JSON.stringify(identity)}`, async () => {
    const request = transport([]);
    await assert.rejects(findOrCreateXeroContact('test-only', 'isolated-company', identity, request), /identity/);
    assert.equal(request.calls.length, 0);
  });
}
