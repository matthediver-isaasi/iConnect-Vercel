import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';
import { supabase } from '../api/_lib/database.js';
import { getValidXeroAccessToken } from '../api/_lib/xero.js';
import { processEventInvoiceRecovery } from '../api/_lib/eventInvoiceRecovery.js';
import { createEventInvoiceRecoveryXero } from '../api/_lib/eventInvoiceRecoveryXero.js';

// Owner-approved exact two-record repair; no external accounting writes allowed.
assert.equal(process.argv[2], '--apply');
const tenant = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const event = '773735fb-f713-4d04-995d-1f0bf88c39be';
const targets = [
  ['20f94042-cbd9-4152-bd50-b3a85c3df474', '1e3d4132-d0ed-4155-95f5-65285ef9cc73', 'SI-44929'],
  ['9998d071-6859-4e27-9dcc-a1570e434f23', '3d6dff63-6025-43a7-94dc-840d94daf433', 'SI-44975'],
];
const auth = await getValidXeroAccessToken(tenant, { requireEnabled: true });
assert.equal(auth.tenantId, '608971fe-5a0d-4031-80bb-3d9d438e90fb');
const c = await connectDestination();
try {
  for (const [id, invoiceId, invoiceNumber] of targets) {
    let original;
    let claimed;
    // Requeue and obtain a real fenced worker claim atomically so an old cron
    // cannot take this job between those operations.
    await c.query('BEGIN');
    try {
      const rows = (await c.query(`select * from event_invoice_recovery where id=$1 and tenant_id=$2 for update`, [id, tenant])).rows;
      assert.equal(rows.length, 1);
      original = rows[0];
      assert.equal(original.status, 'needs_review');
      assert.equal(original.reason_code, 'invoice_evidence_mismatch');
      assert.equal(original.source, 'booking');
      assert.equal(original.invoice_id, invoiceId);
      assert.equal(original.invoice_number, invoiceNumber);
      assert.equal(original.snapshot.paymentMethod, 'invoice');
      assert.equal(original.snapshot.amount, 65);
      assert.equal(original.snapshot.provider.xeroTenantId, auth.tenantId);
      const bookings = (await c.query(`select id from booking where tenant_id=$1 and event_id=$2
        and booking_group_reference=$3 and status='confirmed' and total_cost=65
        and xero_invoice_id is null for update`, [tenant, event, original.booking_group_reference])).rows;
      assert.equal(bookings.length, 1);
      await c.query(`update event_invoice_recovery set status='retry', next_attempt_at=now(), updated_at=now()
        where id=$1 and tenant_id=$2`, [id, tenant]);
      claimed = (await c.query(`select to_jsonb(event_invoice_recovery_claim($1::uuid,'booking',$2,true)) as job`,
        [tenant, original.booking_group_reference])).rows[0].job;
      assert.equal(claimed?.id, id, 'Target must be claimed before committing');
      await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    let suppliedClaim = false;
    const db = {
      from: (...args) => supabase.from(...args),
      rpc(name, args) {
        if (name === 'event_invoice_recovery_claim') {
          assert.equal(suppliedClaim, false);
          assert.equal(args.p_tenant_id, tenant);
          assert.equal(args.p_group, original.booking_group_reference);
          suppliedClaim = true;
          return Promise.resolve({ data: claimed, error: null });
        }
        return supabase.rpc(name, args);
      },
    };
    const result = await processEventInvoiceRecovery({
      db, tenantId: tenant, source: 'booking', bookingGroupReference: original.booking_group_reference,
      providerFactory: options => createEventInvoiceRecoveryXero({
        ...options,
        fetchImpl: (url, init = {}) => {
          assert.equal(init.method || 'GET', 'GET', 'Accounting writes are prohibited');
          assert.equal(new URL(url).origin, 'https://api.xero.com');
          return fetch(url, init);
        },
      }),
    });
    assert.equal(result.status, 'complete', `Stopped: ${invoiceNumber}: ${result.status}`);
    const after = (await c.query(`select status,snapshot,invoice_id from event_invoice_recovery where id=$1`, [id])).rows[0];
    assert.equal(after.status, 'complete');
    assert.equal(after.invoice_id, invoiceId);
    assert.deepEqual(after.snapshot, original.snapshot);
    const booking = (await c.query(`select xero_invoice_id,xero_invoice_number,total_cost,status
      from booking where tenant_id=$1 and event_id=$2 and booking_group_reference=$3`,
      [tenant, event, original.booking_group_reference])).rows;
    assert.equal(booking.length, 1);
    assert.equal(booking[0].xero_invoice_id, invoiceId);
    assert.equal(booking[0].xero_invoice_number, invoiceNumber);
    assert.equal(Number(booking[0].total_cost), 65);
    assert.equal(booking[0].status, 'confirmed');
    console.log(JSON.stringify({ invoice: invoiceNumber, status: after.status, bookingLinked: true, accountingWrites: 0 }));
  }
} finally { await c.end(); }
