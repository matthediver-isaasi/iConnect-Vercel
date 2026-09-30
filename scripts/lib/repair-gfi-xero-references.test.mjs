import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDryRunManifest,
  authenticateRepairConnection,
  changeSinceDryRunReason,
  isLegacyMembershipReference,
  isUnpaidInvoice,
  loadMembershipHistory,
  validateManifest,
  signManifest,
  processReviewedInvoice,
} from './repair-gfi-xero-references.mjs';

const invoice = {
  InvoiceID: 'inv-1', InvoiceNumber: 'INV-1', Type: 'ACCREC',
  Status: 'AUTHORISED', AmountDue: 100, Total: 100,
  Reference: 'Membership 2025/2026', Contact: { ContactID: 'c1', Name: 'Example' },
};
const target = { id: 'tenant-1', slug: 'gfi', name: 'Graduate Futures Institute' };
const secret = 'test-only-secret';

test('repair authentication reuses a fresh token through the shared helper', async () => {
  let calls = 0;
  const auth = await authenticateRepairConnection({
    tenantId: target.id,
    connections: [{ tenant_id: 'xero-1', expires_at: '2099-01-01T00:00:00.000Z' }],
    getAccessToken: async (tenantId) => {
      calls++;
      assert.equal(tenantId, target.id);
      return { accessToken: 'fresh-access', tenantId: 'xero-1' };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(auth, { accessToken: 'fresh-access', tenantId: 'xero-1' });
});

test('repair authentication delegates near-expiry refresh to the shared helper', async () => {
  const auth = await authenticateRepairConnection({
    tenantId: target.id,
    connections: [{ tenant_id: 'xero-1', expires_at: '2000-01-01T00:00:00.000Z' }],
    getAccessToken: async () => ({ accessToken: 'rotated-access', tenantId: 'xero-1' }),
  });
  assert.equal(auth.accessToken, 'rotated-access');
});

test('repair authentication gives reconnect guidance only when refresh fails', async () => {
  await assert.rejects(
    authenticateRepairConnection({
      tenantId: target.id,
      connections: [{ tenant_id: 'xero-1', expires_at: '2000-01-01T00:00:00.000Z' }],
      getAccessToken: async () => { throw new Error('[Xero token-refresh] HTTP 400: invalid_grant'); },
    }),
    /could not be refreshed.*Reconnect Xero.*invalid_grant/,
  );
  await assert.rejects(
    authenticateRepairConnection({
      tenantId: target.id,
      connections: [{ tenant_id: 'PENDING_SELECTION' }],
      getAccessToken: async () => assert.fail('helper must not run'),
    }),
    /connection is incomplete.*Select a Xero organisation/,
  );
  await assert.rejects(
    authenticateRepairConnection({
      tenantId: target.id,
      connections: [{ tenant_id: 'xero-1', expires_at: '2099-01-01T00:00:00.000Z' }],
      getAccessToken: async () => { throw new Error('database unavailable'); },
    }),
    (error) => error.message === 'database unavailable',
  );
});

test('membership history lookup uses each table owner column and keeps tenant scope', async () => {
  const calls = [];
  const tableRows = {
    organisation_membership_history: [{
      id: 'org-history',
      tenant_id: target.id,
      organization_id: 'org-1',
    }],
    member_membership_history: [{
      id: 'member-history',
      tenant_id: target.id,
      member_id: 'member-1',
    }],
  };
  const supabase = {
    from(table) {
      calls.push({ table });
      const call = calls.at(-1);
      const query = {
        select(columns) {
          call.columns = columns;
          return query;
        },
        eq(column, value) {
          call.eq = [column, value];
          return query;
        },
        or(filter) {
          call.or = filter;
          return Promise.resolve({ data: tableRows[table], error: null });
        },
      };
      return query;
    },
  };

  const rows = await loadMembershipHistory({
    supabase,
    tenantId: target.id,
    invoice,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].columns, /organization_id/);
  assert.doesNotMatch(calls[0].columns, /member_id/);
  assert.match(calls[1].columns, /member_id/);
  assert.doesNotMatch(calls[1].columns, /organization_id/);
  for (const call of calls) {
    assert.deepEqual(call.eq, ['tenant_id', target.id]);
    assert.match(call.or, /xero_invoice_id\.eq\.inv-1/);
    assert.match(call.or, /accounting_invoice_id\.eq\.inv-1/);
    assert.match(call.or, /xero_invoice_number\.eq\.INV-1/);
    assert.match(call.or, /accounting_invoice_number\.eq\.INV-1/);
  }
  assert.deepEqual(rows, [
    { table: 'organisation_membership_history', ...tableRows.organisation_membership_history[0] },
    { table: 'member_membership_history', ...tableRows.member_membership_history[0] },
  ]);
});

test('membership history lookup fails explicitly on a returned database error', async () => {
  const supabase = {
    from() {
      const query = {
        select() { return query; },
        eq() { return query; },
        or() {
          return Promise.resolve({
            data: null,
            error: { message: 'schema unavailable' },
          });
        },
      };
      return query;
    },
  };

  await assert.rejects(
    loadMembershipHistory({
      supabase,
      tenantId: target.id,
      invoice,
    }),
    /Could not link organisation_membership_history: schema unavailable/,
  );
});

test('legacy matcher accepts only the exact historical shape', () => {
  assert.equal(isLegacyMembershipReference('Membership 2025'), true);
  assert.equal(isLegacyMembershipReference('Membership 2025/2026'), true);
  assert.equal(isLegacyMembershipReference('Membership 2025/26'), true);
  assert.equal(isLegacyMembershipReference('Membership 2025/1999'), false);
  assert.equal(isLegacyMembershipReference('membership 2025/2026'), false);
  assert.equal(isLegacyMembershipReference('Membership 2025/26 - PO: ABC'), false);
  assert.equal(isLegacyMembershipReference('PO-123'), false);
});

test('unpaid eligibility requires a positive balance and non-terminal status', () => {
  assert.equal(isUnpaidInvoice(invoice), true);
  assert.equal(isUnpaidInvoice({ ...invoice, AmountDue: 0 }), false);
  assert.equal(isUnpaidInvoice({ ...invoice, Status: 'PAID' }), false);
  assert.equal(isUnpaidInvoice({ ...invoice, Status: 'VOIDED' }), false);
  assert.equal(isUnpaidInvoice({ ...invoice, Status: 'DELETED' }), false);
});

test('manifest validation pins tenant, Xero organisation and reviewed values', async () => {
  let saved;
  const manifest = await buildDryRunManifest({
    tenant: target, xeroTenantId: 'xero-1', invoices: [invoice],
    loadHistory: async () => [], writeReport: async (value) => { saved = value; },
    signingSecret: secret,
  });
  assert.equal(validateManifest(saved, { tenantId: target.id, xeroTenantId: 'xero-1' }, secret), true);
  assert.throws(
    () => validateManifest(manifest, { tenantId: target.id, xeroTenantId: 'other' }, secret),
    /Xero organisation/,
  );
  manifest.selected[0].amountDue = 1;
  assert.throws(
    () => validateManifest(manifest, { tenantId: target.id, xeroTenantId: 'xero-1' }, secret),
    /signature/,
  );
  manifest.signature = signManifest(manifest, secret);
  manifest.selected.push({ ...manifest.selected[0] });
  manifest.signature = signManifest(manifest, secret);
  assert.throws(
    () => validateManifest(manifest, { tenantId: target.id, xeroTenantId: 'xero-1' }, secret),
    /duplicate/,
  );
});

test('change protection catches balance, status and reference drift', () => {
  const reviewed = {
    invoiceId: 'inv-1', invoiceNumber: 'INV-1', amountDue: 100,
    status: 'AUTHORISED', originalReference: 'Membership 2025/2026',
  };
  assert.equal(changeSinceDryRunReason(reviewed, invoice), null);
  assert.equal(changeSinceDryRunReason(reviewed, { ...invoice, AmountDue: 90 }), 'balance-changed');
  assert.equal(changeSinceDryRunReason(reviewed, { ...invoice, Reference: 'PO-1' }), 'reference-changed');
  assert.equal(changeSinceDryRunReason(reviewed, { ...invoice, Status: 'PAID', AmountDue: 0 }), 'no-longer-unpaid');
});

test('dry run writes a report but invokes no mutation dependency', async () => {
  let writes = 0;
  let mutations = 0;
  const report = await buildDryRunManifest({
    tenant: target, xeroTenantId: 'xero-1', invoices: [invoice],
    loadHistory: async () => [{ table: 'organisation_membership_history', id: 'h1' }],
    writeReport: async () => { writes++; },
    updateInvoice: async () => { mutations++; },
    signingSecret: secret,
  });
  assert.equal(writes, 1);
  assert.equal(mutations, 0);
  assert.equal(report.mutationCount, 0);
  assert.equal(report.selected.length, 1);
});

test('failed write-ahead checkpoint prevents the Xero mutation', async () => {
  let updates = 0;
  const reviewed = {
    invoiceId: 'inv-1', invoiceNumber: 'INV-1', amountDue: 100,
    status: 'AUTHORISED', originalReference: 'Membership 2025/2026',
  };
  await assert.rejects(
    processReviewedInvoice({
      reviewed,
      fetchInvoice: async () => invoice,
      updateInvoice: async () => { updates++; },
      checkpoint: async (outcome) => {
        if (outcome.state === 'updating') throw new Error('disk unavailable');
      },
    }),
    /disk unavailable/,
  );
  assert.equal(updates, 0);
});

test('write-ahead journal marks an invoice updating before provider mutation', async () => {
  const states = [];
  let current = invoice;
  const reviewed = {
    invoiceId: 'inv-1', invoiceNumber: 'INV-1', amountDue: 100,
    status: 'AUTHORISED', originalReference: 'Membership 2025/2026',
  };
  const outcome = await processReviewedInvoice({
    reviewed,
    fetchInvoice: async () => current,
    updateInvoice: async () => {
      assert.deepEqual(states, ['updating']);
      current = { ...invoice, Reference: 'TBC' };
      return { InvoiceID: 'inv-1', Reference: 'TBC' };
    },
    checkpoint: async (value) => { states.push(value.state); },
  });
  assert.deepEqual(states, ['updating', 'verifying', 'complete']);
  assert.equal(outcome.result, 'success');
});

function rateLimitError(retryAfterMs = 25) {
  return Object.assign(new Error('Xero HTTP 429'), {
    status: 429,
    retryAfterMs,
    xeroResponse: { ErrorNumber: 429 },
  });
}

const reviewedInvoice = {
  invoiceId: 'inv-1', invoiceNumber: 'INV-1', amountDue: 100,
  status: 'AUTHORISED', originalReference: 'Membership 2025/2026',
};

test('pre-check 429 waits durably and does not mark the invoice attempted', async () => {
  let fetches = 0;
  let updates = 0;
  const checkpoints = [];
  const sleeps = [];
  let current = invoice;
  const outcome = await processReviewedInvoice({
    reviewed: reviewedInvoice,
    fetchInvoice: async () => {
      fetches++;
      if (fetches === 1) throw rateLimitError(123);
      return current;
    },
    updateInvoice: async () => {
      updates++;
      current = { ...invoice, Reference: 'TBC' };
      return current;
    },
    checkpoint: async (value) => checkpoints.push(structuredClone(value)),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(sleeps, [123]);
  assert.equal(updates, 1);
  assert.equal(outcome.result, 'success');
  const wait = checkpoints.find((item) => item.rateLimit?.phase === 'precheck');
  assert.equal(wait.attempted, false);
  assert.equal(wait.state, 'rate-limit-wait');
  assert.equal(outcome.rateLimitHistory[0].phase, 'precheck');
});

test('update 429 retries without duplicating a successful invoice mutation', async () => {
  let updateRequests = 0;
  let mutations = 0;
  let current = invoice;
  const outcome = await processReviewedInvoice({
    reviewed: reviewedInvoice,
    fetchInvoice: async () => current,
    updateInvoice: async () => {
      updateRequests++;
      if (updateRequests === 1) throw rateLimitError();
      mutations++;
      current = { ...invoice, Reference: 'TBC' };
      return current;
    },
    checkpoint: async () => {},
    sleep: async () => {},
  });
  assert.equal(updateRequests, 2);
  assert.equal(mutations, 1);
  assert.equal(outcome.result, 'success');
});

test('verification 429 retries only the read and never repeats the mutation', async () => {
  let fetches = 0;
  let mutations = 0;
  let current = invoice;
  const outcome = await processReviewedInvoice({
    reviewed: reviewedInvoice,
    fetchInvoice: async () => {
      fetches++;
      if (fetches === 2) throw rateLimitError();
      return current;
    },
    updateInvoice: async () => {
      mutations++;
      current = { ...invoice, Reference: 'TBC' };
      return current;
    },
    checkpoint: async () => {},
    sleep: async () => {},
  });
  assert.equal(mutations, 1);
  assert.equal(fetches, 3);
  assert.equal(outcome.result, 'success');
  assert.equal(outcome.rateLimitHistory[0].phase, 'verification');
});

test('reusing a signed manifest records an already repaired invoice as complete', async () => {
  let mutations = 0;
  const outcome = await processReviewedInvoice({
    reviewed: reviewedInvoice,
    fetchInvoice: async () => ({ ...invoice, Reference: 'TBC' }),
    updateInvoice: async () => { mutations++; },
    checkpoint: async () => {},
  });
  assert.equal(mutations, 0);
  assert.equal(outcome.result, 'skipped');
  assert.equal(outcome.reason, 'already-complete');
  assert.equal(outcome.attempted, false);
});
