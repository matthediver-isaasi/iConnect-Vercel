import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('member complex API preserves safe recovery/linkage fields but strips provider diagnostics', async () => {
  let source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\r?$/gm, '').replace('export default async function handler', 'async function handler');
  const booking = {
    id: 'booking', tenant_id: 'tenant', member_id: 'member', event_id: 'event',
    accounting_provider: 'xero', accounting_invoice_id: 'generic', xero_invoice_id: 'legacy',
    invoice_recovery_status: 'retry', invoice_recovery_next_attempt_at: '2026-12-01T12:00:00Z',
    xero_invoice_error: 'PRIVATE', accounting_sync_error: 'PRIVATE',
    accounting_invoice_error: 'PRIVATE', invoice_recovery_error: 'PRIVATE', invoice_recovery_last_error: 'PRIVATE',
  };
  const calls = [];
  const db = { from(table) {
    const call = { table, filters: {} };
    calls.push(call);
    const q = {
      select() { return q; }, eq(key, value) { call.filters[key] = value; return q; },
      in() { return q; }, or(value) { call.memberFilter = value; return q; }, order() { return q; },
      then(resolve) { return Promise.resolve({ data: table === 'complex_event_booking' ? [booking] : [], error: null }).then(resolve); },
    };
    return q;
  } };
  const handler = new Function('supabase', 'getSessionMember', `${source}; return handler;`)(db, async () => ({
    id: 'member', tenant_id: 'tenant', email: 'member@example.invalid',
  }));
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 200);
  const record = res.body.bookings[0];
  assert.equal(record.invoice_recovery_status, 'retry');
  assert.equal(record.invoice_recovery_next_attempt_at, '2026-12-01T12:00:00Z');
  assert.equal(record.accounting_invoice_id, 'generic');
  assert.equal(record.xero_invoice_id, 'legacy');
  assert.equal(record.accounting_provider, 'xero');
  assert.doesNotMatch(JSON.stringify(res.body), /PRIVATE/);
  assert.match(calls[0].memberFilter, /member_id.eq.member/);
  for (const call of calls) assert.equal(call.filters.tenant_id, 'tenant');
});