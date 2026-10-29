import test from 'node:test';
import assert from 'node:assert/strict';
import { hasActiveQuoteLink, scopeActiveQuoteLinks } from './salesQuoteActiveLink.js';

test('read and revoke share tenant, quote, version and active predicates', () => {
  const calls = [];
  const q = {};
  for (const method of ['eq', 'not', 'is', 'gt']) q[method] = (...args) => { calls.push([method, ...args]); return q; };
  assert.equal(scopeActiveQuoteLinks(q, 'tenant', 'quote', 'version', 'now'), q);
  assert.deepEqual(calls, [
    ['eq', 'tenant_id', 'tenant'], ['eq', 'quote_id', 'quote'],
    ['eq', 'quote_version_id', 'version'], ['not', 'activated_at', 'is', null],
    ['is', 'revoked_at', null], ['gt', 'expires_at', 'now'],
  ]);
});
test('metadata is boolean only, absence false and errors never become false evidence', async () => {
  let result = { data: [] };
  const q = { limit: async () => result };
  for (const method of ['select', 'eq', 'not', 'is', 'gt']) q[method] = () => q;
  const db = { from: () => q };
  assert.equal(await hasActiveQuoteLink(db, 't', 'q', 'v'), false);
  result = { data: [{ id: 'private-id' }] };
  assert.equal(await hasActiveQuoteLink(db, 't', 'q', 'v'), true);
  result = { error: new Error('unavailable') };
  await assert.rejects(hasActiveQuoteLink(db, 't', 'q', 'v'), /unavailable/);
  assert.equal(await hasActiveQuoteLink(db, 't', 'q', null), false);
});
