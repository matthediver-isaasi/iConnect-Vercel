import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quoteSenderOptions, resolveQuoteSender } from './salesQuoteSenders.js';
import { previewQuoteEmail, sendQuote } from './salesQuoteDelivery.js';
import { quoteSenderHeaders } from './emailService.js';

const actor = { tenantId: 'tenant', actorType: 'member', actorId: 'self' };
const quote = { opportunity_id: 'opp' };
const collaboratorDefinition = readFileSync(new URL('../../supabase/migrations/20260908_opportunity_pipeline.sql', import.meta.url), 'utf8')
  .match(/CREATE TABLE IF NOT EXISTS public\.opportunity_collaborator \(([\s\S]*?)\n\);/)[1];
const collaboratorColumns = new Set([...collaboratorDefinition.matchAll(/^  (\w+) (?:uuid|varchar|timestamptz)\b/gm)].map(match => match[1]));
function fixture({ removed = false, fail = false } = {}) {
  const rows = {
    opportunity: [{ tenant_id: 'tenant', id: 'opp', owner_kind: 'tenant_user', owner_id: 'owner' }],
    opportunity_collaborator: removed ? [] : [
      { tenant_id: 'tenant', opportunity_id: 'opp', principal_kind: 'member', principal_id: 'self' },
      { tenant_id: 'tenant', opportunity_id: 'opp', principal_kind: 'member', principal_id: 'customer' },
      { tenant_id: 'tenant', opportunity_id: 'opp', principal_kind: 'member', principal_id: 'deleted' },
      { tenant_id: 'tenant', opportunity_id: 'opp', principal_kind: 'member', principal_id: 'foreign' },
    ],
    organization: [{ tenant_id: 'tenant', id: 'primary', is_primary: true }],
    member: [
      { tenant_id: 'tenant', id: 'self', organization_id: 'primary', first_name: 'Staff', email: 'staff@example.org' },
      { tenant_id: 'tenant', id: 'customer', organization_id: 'customer-org', email: 'customer@example.org' },
      { tenant_id: 'tenant', id: 'deleted', organization_id: 'primary', email: 'deleted_1@deleted.local' },
      { tenant_id: 'other-tenant', id: 'foreign', organization_id: 'primary', email: 'foreign@example.org' },
    ],
    tenant_user: [{ tenant_id: 'tenant', id: 'owner', first_name: 'Owner', email: 'owner@example.org' }],
  };
  return { from(table) {
    let filtered = rows[table] || [];
    const orders = [];
    const checkColumn = column => {
      if (table === 'opportunity_collaborator') assert.ok(collaboratorColumns.has(column), `Unknown collaborator column: ${column}`);
    };
    return { select(columns) { columns.split(',').forEach(checkColumn); return this; },
      eq(k, v) { checkColumn(k); filtered = filtered.filter(r => r[k] === v); return this; },
      order(column) { checkColumn(column); orders.push(column); return this; },
      async range(a, b) {
        if (table === 'opportunity_collaborator') assert.deepEqual(orders, ['principal_kind', 'principal_id']);
        return { data: filtered.slice(a, b + 1), error: fail ? new Error('Unavailable') : null };
      },
      async maybeSingle() { return { data: filtered[0] || null }; },
    };
  } };
}
const deps = { getTenantEmailConfig: async () => ({ fromEmail: 'sales@tenant.example' }) };
test('sender choices include owner and primary-team collaborators only; default is authenticated principal', async () => {
  const result = await quoteSenderOptions(fixture(), quote, actor);
  assert.deepEqual(result.items.map(p => p.key), ['tenant_user:owner', 'member:self']);
  assert.equal(result.defaultSenderKey, 'member:self');
  assert.equal((await quoteSenderOptions(fixture(), quote, { ...actor, actorId: 'admin' })).defaultSenderKey, null);
});
test('server resolves trusted headers, rejects forged/stale selection and requires outsider explicit choice', async () => {
  const sender = await resolveQuoteSender(fixture(), quote, actor, undefined, deps);
  assert.equal(sender.from, '"Staff" <sales@tenant.example>');
  assert.equal(sender.replyTo, 'staff@example.org');
  for (const key of ['member:customer', 'member:foreign', 'member:deleted', '', { email: 'fake@example.org' }]) {
    await assert.rejects(resolveQuoteSender(fixture(), quote, actor, key, deps), /Select a current/);
  }
  await assert.rejects(resolveQuoteSender(fixture({ removed: true }), quote, actor, 'member:self', deps), /Select a current/);
  await assert.rejects(resolveQuoteSender(fixture(), quote, { ...actor, actorId: 'admin' }, undefined, deps), /Select a current/);
  assert.equal((await resolveQuoteSender(fixture(), quote, { ...actor, actorId: 'admin' }, 'tenant_user:owner', deps)).id, 'owner');
  await assert.rejects(quoteSenderOptions(fixture({ fail: true }), quote, actor), /Unavailable/);
});

test('preview and delivery use the resolved identity; audits retain actor and sender separately', async () => {
  const sender = await resolveQuoteSender(fixture(), quote, actor, 'tenant_user:owner', deps);
  const audits = [];
  const calls = [];
  const db = { from(table) {
    return {
      insert(row) {
        if (table === 'sales_quote_delivery_audit') { audits.push(row); return Promise.resolve({ error: null }); }
        return { select() { return this; }, single: async () => ({ data: { id: 'token' } }) };
      },
      update() { return this; }, eq() { return this; }, is: async () => ({ error: null }),
    };
  } };
  const input = {
    quote: { id: 'quote', tenant_id: 'tenant', quote_number: 'Q1' },
    version: { id: 'version', status: 'sent', version_number: 1 },
    actor, sender, recipient: 'customer@example.org', expiresInDays: 7,
    attachPdf: false, baseUrl: 'https://tenant.example',
    sendEmail: async message => { calls.push(message); return { success: true, domain: 'tenant.example', messageId: 'provider' }; },
  };
  const preview = await previewQuoteEmail(input, { getEmailFooterForPreview: async () => null });
  assert.equal(preview.from, sender.from);
  assert.equal(preview.replyTo, sender.email);
  assert.equal(calls.length, 0);
  await sendQuote(db, input);
  assert.equal(calls[0].from, preview.from);
  assert.equal(calls[0].replyTo, preview.replyTo);
  assert.deepEqual(audits.map(row => row.event_type), ['send_attempt', 'sent']);
  for (const row of audits) {
    assert.equal(row.actor_id, 'self');
    assert.equal(row.request_metadata.actor_type, 'member');
    assert.equal(row.request_metadata.sender.id, 'owner');
    assert.equal(row.request_metadata.sender.kind, 'tenant_user');
  }
});

test('sender names cannot inject headers and platform fallback retains the selected Reply-To', async () => {
  const headers = await quoteSenderHeaders('tenant', { name: 'Name"\r\nBcc: bad\\', email: 'staff@example.org' },
    { getTenantEmailConfig: async () => null, defaultFrom: 'Platform <noreply@platform.example>' });
  assert.equal(headers.from, '"Name  Bcc: bad" <noreply@platform.example>');
  assert.equal(headers.replyTo, 'staff@example.org');
  assert.doesNotMatch(headers.from, /[\r\n]/);
});
