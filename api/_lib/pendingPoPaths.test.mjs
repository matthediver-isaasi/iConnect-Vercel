import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as shared from './pendingPoInvoice.js';
import { readPoXeroInvoices } from './pendingPoAuthority.js';

// Execute the actual handlers and shared reminder preparation. Only database,
// provider transport, authentication and delivery boundaries are replaced.
async function loadHandler(path, dependencies) {
  const source = (await readFile(new URL(path, import.meta.url), 'utf8'))
    .replace('process.env.CRON_SECRET', "'fixture-cron-secret'");
  const slot = `__poPathFixture${loadHandler.next++}`;
  globalThis[slot] = dependencies;
  const rewritten = source.replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"][^'"]+['"];?/g,
    (_, names) => `const { ${names.replace(/\s+as\s+/g, ': ')} } = globalThis.${slot};`);
  const handler = (await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`)).default;
  return { handler, cleanup: () => { delete globalThis[slot]; } };
}
loadHandler.next = 1;

function fixture(status = 'AUTHORISED', { unverified = false, allowWrites = false } = {}) {
  const sends = [];
  const writes = [];
  const rows = {
    organization: [{ id: 'org-1', tenant_id: 'tenant-1', name: 'Fixture Organisation' }],
    member: [{ id: 'member-1', tenant_id: 'tenant-1', organization_id: 'org-1', first_name: 'Fixture', last_name: 'Booker', email: 'buyer@example.org' }],
    booking: [{
      id: 'booking-1', organization_id: 'org-1', member_id: 'member-1', xero_invoice_id: 'invoice-1',
      xero_invoice_number: 'SI-45027', total_cost: 675, ticket_price: 675, attendee_email: 'buyer@example.org',
      status: 'active', payment_method: 'account', created_at: '2026-01-01T00:00:00Z',
    }],
    tenant: [{ id: 'tenant-1', name: 'Fixture Tenant', slug: 'fixture', settings: {
      poReminderSettings: { reminderDays: [0, 1, 2, 3, 4, 5, 6], sendAfterDays: 1 },
    } }],
    pending_po_token: [{
      id: 'token-row', token: 'preview-token', invoice_key: 'id:invoice-1', tenant_id: 'tenant-1',
      status: 'pending', recipient_email: 'buyer@example.org', expires_at: '2099-01-01T00:00:00Z',
    }],
  };
  const db = { from(table) {
    const filters = [];
    let operation = 'select', values, start, end;
    const execute = () => {
      const matches = (rows[table] || []).filter(row => filters.every(([method, col, value]) => {
        if (method === 'eq') return row[col] === value;
        if (method === 'neq') return row[col] !== value;
        if (method === 'is') return (row[col] ?? null) === value;
        if (method === 'in') return value.includes(row[col]);
        return true;
      }));
      if (operation !== 'select') {
        if (!allowWrites && table !== 'scheduled_task_log') throw new Error(`Forbidden write to ${table}`);
        writes.push({ table, operation, values });
        return { data: values, error: null };
      }
      return { data: start === undefined ? matches : matches.slice(start, end + 1), error: null };
    };
    const q = {
      select(columns) { assert.ok(!columns.includes('is_primary_contact')); return q; },
      eq(c, v) { assert.notEqual(c, 'is_primary_contact'); filters.push(['eq', c, v]); return q; },
      neq(c, v) { filters.push(['neq', c, v]); return q; },
      is(c, v) { filters.push(['is', c, v]); return q; },
      in(c, v) { filters.push(['in', c, v]); return q; },
      or() { return q; }, not() { return q; }, order() { return q; }, limit() { return q; },
      range(a, b) { start = a; end = b; return Promise.resolve(execute()); },
      maybeSingle() { const result = execute(); return Promise.resolve({ ...result, data: result.data?.[0] || null }); },
      single() { return q.maybeSingle(); },
      insert(v) { operation = 'insert'; values = v; return q; },
      update(v) { operation = 'update'; values = v; return q; },
      then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); },
    };
    return q;
  } };
  const readXero = async (tenantId, refs) => {
    if (unverified) throw new Error('Fixture Xero unavailable');
    return readPoXeroInvoices(tenantId, refs, {
      getProvider: async () => ({ name: 'xero', getRawAccessToken: async () => ({ accessToken: 'fixture', tenantId: 'xero-org' }) }),
      fetcher: async url => ({ ok: true, json: async () => url.endsWith('/Organisation')
        ? { Organisations: [{ OrganisationID: 'xero-org', BaseCurrency: 'GBP' }] }
        : { Invoices: [{ InvoiceID: 'invoice-1', InvoiceNumber: 'SI-45027', Total: 375, CurrencyCode: 'GBP', Status: status }] } }),
    });
  };
  const dependencies = {
    ...shared, supabase: db,
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1', tenantUserId: 'admin-fixture' }),
    checkCrossOrgPermissions: async () => ({ hasCrossOrgAccess: true }),
    prepareReminderForInvoice: args => shared.prepareReminderForInvoice({ ...args, readXero }),
    summariseInvoice: (client, tenantId, key) => shared.summariseInvoice(client, tenantId, key, { readXero }),
    computePendingPoInvoices: args => shared.computePendingPoInvoices({ ...args, readXero }),
    sendTenantEmail: async args => { sends.push(args); return { success: true }; },
    buildInboxDelivery: async () => null,
    applyInvoicePoUpdate: async () => { throw new Error('PO update must not run for a blocked invoice'); },
    sendPoSubmissionNotification: async () => { throw new Error('Notification must not run for a blocked invoice'); },
  };
  return { dependencies, sends, writes };
}

async function request(path, deps, req) {
  const loaded = await loadHandler(path, deps);
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  try { await loaded.handler({ headers: {}, query: {}, ...req }, res); }
  finally { loaded.cleanup(); }
  return res;
}

test('preview, direct, bulk, confirm, scheduled and public routes block paid/void/deleted and unverified invoices', async () => {
  for (const status of ['VOIDED', 'DELETED', 'PAID', 'UNVERIFIED']) {
    const f = fixture(status, { unverified: status === 'UNVERIFIED' });
    for (const body of [
      { action: 'preview_reminder', entityType: 'invoice', recordId: 'id:invoice-1' },
      { action: 'send_reminder', entityType: 'invoice', recordId: 'id:invoice-1' },
      // The UI bulk sender issues this same direct request per invoice.
      ...Array.from({ length: 2 }, () => ({ action: 'send_reminder', entityType: 'invoice', recordId: 'id:invoice-1' })),
      { action: 'send_reminder', token: 'preview-token' },
    ]) {
      const result = await request('../pending-purchase-orders/index.js', f.dependencies, { method: 'POST', body });
      assert.equal(result.statusCode, status === 'UNVERIFIED' ? 503 : 409, JSON.stringify(result.body));
    }
    for (const method of ['GET', 'POST']) {
      const result = await request('../public/pending-po/[token].js', f.dependencies, {
        method, query: { token: 'preview-token' }, body: { action: 'submit_po', poNumber: 'PO-fixture' },
      });
      assert.equal(result.statusCode, status === 'UNVERIFIED' ? 503 : 409);
    }
    const cron = await request('../cron/send-po-reminders.js', f.dependencies, { method: 'GET',
      headers: { authorization: 'Bearer fixture-cron-secret' } });
    assert.equal(cron.statusCode, 200, JSON.stringify(cron.body));
    assert.equal(cron.body.sent, 0);
    assert.equal(f.sends.length, 0);
    assert.ok(f.writes.every(write => write.table === 'scheduled_task_log'));
    assert.match(f.writes[0].values.details.reminders_skipped[0].reason, /paid|voided|deleted|verified/i);
  }
});

test('preview-confirm and direct delivery share exact HTML, greeting and verified amount; public GET agrees', async () => {
  const f = fixture('AUTHORISED', { allowWrites: true });
  const preview = await request('../pending-purchase-orders/index.js', f.dependencies, {
    method: 'POST', body: { action: 'preview_reminder', entityType: 'invoice', recordId: 'id:invoice-1' },
  });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.body));
  const tokenInsert = f.writes.find(w => w.table === 'pending_po_token');
  const tokenRow = { ...tokenInsert.values, id: 'new-token' };
  // Reuse the exact preview token through a DB wrapper, as the real endpoint does.
  const originalFrom = f.dependencies.supabase.from;
  f.dependencies.supabase.from = table => {
    if (table !== 'pending_po_token') return originalFrom(table);
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: tokenRow, error: null }) };
    return q;
  };
  const confirmed = await request('../pending-purchase-orders/index.js', f.dependencies, {
    method: 'POST', body: { action: 'send_reminder', token: preview.body.token },
  });
  assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.body));
  assert.equal(f.sends[0].html, preview.body.html);
  assert.match(f.sends[0].html, /£375.00/);
  assert.match(f.sends[0].html, /Dear Fixture Booker,/);
  assert.equal(f.writes.filter(w => w.table === 'pending_po_token').length, 1);
  const publicPage = await request('../public/pending-po/[token].js', f.dependencies, { method: 'GET', query: { token: preview.body.token } });
  assert.equal(publicPage.statusCode, 200);
  assert.equal(publicPage.body.invoice.totalCost, 375);
  const direct = fixture('AUTHORISED', { allowWrites: true });
  const directResponse = await request('../pending-purchase-orders/index.js', direct.dependencies, {
    method: 'POST', body: { action: 'send_reminder', entityType: 'invoice', recordId: 'id:invoice-1' },
  });
  assert.equal(directResponse.statusCode, 200);
  assert.equal(direct.sends.length, 1);
  assert.match(direct.sends[0].html, /£375.00/);
  const scheduled = fixture('AUTHORISED', { allowWrites: true });
  const cron = await request('../cron/send-po-reminders.js', scheduled.dependencies, {
    method: 'GET', headers: { authorization: 'Bearer fixture-cron-secret' },
  });
  assert.equal(cron.body.sent, 1);
  assert.match(scheduled.sends[0].html, /£375.00/);
  assert.equal(scheduled.writes.filter(w => w.table === 'po_reminder_log').length, 1);
});

test('manual reminder eligibility remains separate from automatic timing and caps', () => {
  for (const options of [
    { reminderDays: [] },
    { reminderDays: [0, 1, 2, 3, 4, 5, 6], priorCount: 3, maxSends: 3 },
    { reminderDays: [0, 1, 2, 3, 4, 5, 6], sendAfterDays: 7, createdDate: '2026-11-27' },
  ]) {
    const schedule = shared.evaluateReminderSchedule({ now: new Date('2026-11-27T12:00:00Z'), ...options });
    assert.equal(schedule.dueToday, false);
  }
  assert.equal(shared.poInvoiceGuard({ rowCount: 1, amountVerified: true, xeroStatus: 'AUTHORISED' }).ok, true);
});
