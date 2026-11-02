// Exact, owner-approved historical recovery. No provider writes, schedules or emails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
const mode = process.argv[2];
assert.ok(['dry-run','apply','verify'].includes(mode));
const memberId = '979d3059-213a-4c3c-aed6-064c517e7d20';
const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const historyId = '301a1007-b2c1-5b7b-a905-fa24353903eb';
destinationTarget(process.env);
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const db = await connectDestination();
try {
  const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
  const auth = await getValidXeroAccessToken(tenantId);
  assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
  const archive = (await db.query(`SELECT to_jsonb(i) data FROM historical_member_invoice i
    WHERE member_id=$1 AND tenant_id=$2 AND record_kind='invoice'
    AND invoice_date BETWEEN '2025-10-01' AND '2026-09-30' ORDER BY invoice_date`, [memberId, tenantId])).rows.map(r => r.data);
  assert.equal(archive.length, 12);
  const invoices = [];
  for (let n = 0; n < archive.length; n++) {
    const row = archive[n];
    assert.equal(row.invoice_date, new Date(Date.UTC(2025, 9+n, 1)).toISOString().slice(0,10));
    const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${row.xero_document_id}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200);
    const invoice = (await response.json()).Invoices[0];
    assert.equal(invoice.InvoiceID, row.xero_document_id);
    assert.equal(invoice.InvoiceNumber, row.invoice_number);
    assert.equal(invoice.Contact.Name, 'Philip Blower');
    assert.equal(invoice.Status, 'PAID');
    assert.equal(invoice.Total, 13.04);
    assert.equal(invoice.TotalTax, 0);
    assert.equal(invoice.AmountDue, 0);
    assert.equal(invoice.CurrencyCode, 'GBP');
    assert.equal(invoice.AmountPaid, n < 7 ? 13.04 : 0);
    assert.equal(invoice.AmountCredited || 0, n < 7 ? 0 : 13.04);
    assert.ok(invoice.LineItems.every(line => /^Full Member(ship)? UK\s*$/i.test(line.Description)));
    if (n < 7) assert.ok(invoice.Payments.some(payment => /^PM/.test(payment.Reference) && payment.Amount === 13.04));
    invoices.push({ archiveId: row.id, invoiceId: invoice.InvoiceID, invoiceNumber: invoice.InvoiceNumber,
      invoiceDate: row.invoice_date, invoicedMinor: 1304, cashPaidMinor: n < 7 ? 1304 : 0,
      creditedMinor: n < 7 ? 0 : 1304, outstandingMinor: 0,
      payments: (invoice.Payments || []).map(p => ({ id: p.PaymentID, amount: p.Amount, date: p.Date, reference: p.Reference })),
      credits: (invoice.CreditNotes || []).map(c => ({ id: c.CreditNoteID, number: c.CreditNoteNumber, applied: c.AppliedAmount })),
    });
  }
  assert.equal(invoices.reduce((s,i)=>s+i.cashPaidMinor,0), 9128);
  assert.equal(invoices.reduce((s,i)=>s+i.creditedMinor,0), 6520);
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  const beforeRows = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE member_id=$1 AND tenant_id=$2 FOR UPDATE', [memberId,tenantId])).rows;
  assert.equal(beforeRows.length,1);
  const before = beforeRows[0].data;
  assert.equal(before.id, historyId);
  const originalNotes = JSON.parse(before.notes);
  const replay = originalNotes.source === 'approved_settled_monthly_historical_membership';
  if (mode === 'verify') assert.ok(replay);
  if (!replay) {
    assert.equal(originalNotes.source, 'bnms_retained_expiry_historical_entitlement');
    assert.equal(before.payment_status, 'unpaid');
    assert.equal(before.term_start_date, null);
    assert.equal(before.term_end_date, '2026-09-30');
  }
  assert.equal(before.billing_agreement_id, null);
  assert.equal(before.config_id, null);
  assert.equal(before.commitment_snapshot, null);
  const related = async () => {
    const result = {};
    result.member = (await db.query('SELECT to_jsonb(m) data FROM member m WHERE id=$1 AND tenant_id=$2', [memberId,tenantId])).rows;
    for (const table of ['member_preference_value','historical_member_invoice','membership_billing_agreements','membership_payment_plans']) {
      result[table] = (await db.query(`SELECT to_jsonb(t) data FROM ${table} t WHERE member_id=$1 ORDER BY id`, [memberId])).rows;
    }
    return result;
  };
  const protectedBefore = await related();
  const patch = {
    membership_year: '2025/2026', term_start_date: '2025-10-01', term_end_date: '2026-09-30',
    // Rolling commitment fields intentionally remain null: historical payment
    // evidence is not a reconstructed provider agreement or future renewal consent.
    status: 'expired', payment_status: 'paid', payment_method: 'direct_debit', currency: 'GBP',
    annual_cost: 156.48, final_cost: 156.48, total_with_vat: 156.48, vat_amount: 0,
    // No single invoice represents the whole year. Keep all twelve references
    // in the provenance and existing activity records, not a misleading annual link.
    notes: replay ? before.notes : JSON.stringify({
      source: 'approved_settled_monthly_historical_membership', version: 1,
      approvedAt: new Date().toISOString(), previousEvidence: originalNotes,
      termAuthority: 'owner_approved_annual_term_from_monthly_invoice_cohort_and_retained_expiry',
      settlementAuthority: 'owner_approved_cash_and_credit_settlement_verified_in_xero',
      cashPaidMinor: 9128, creditedMinor: 6520, invoicedMinor: 15648, outstandingMinor: 0,
      currency: 'GBP', instalments: invoices, historicalClassPreserved: true,
      historicalDurationMonths: 12,
      currentClassUnchanged: true, futureCollectionConsent: false, providerWrites: 0,
    }),
  };
  if (!replay) {
    if (mode === 'apply') {
      fs.mkdirSync('generated-artifacts/approved-monthly-history', { recursive: true, mode: 0o700 });
      fs.writeFileSync(`generated-artifacts/approved-monthly-history/before-${Date.now()}.json`,
        JSON.stringify({ before, patch, protectedBefore }, null, 2), { mode: 0o600, flag: 'wx' });
    }
    const keys = Object.keys(patch);
    const updated = await db.query(`UPDATE member_membership_history SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')}
      WHERE id=$${keys.length+1} AND tenant_id=$${keys.length+2}`, [...Object.values(patch),historyId,tenantId]);
    assert.equal(updated.rowCount,1);
  }
  const after = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1', [historyId])).rows[0].data;
  for (const [key,value] of Object.entries(patch)) assert.deepEqual(after[key],value,key);
  for (const key of Object.keys(before)) if (!(key in patch) && key !== 'updated_at') assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(await related(), protectedBefore);
  await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ mode, replay, term: [after.term_start_date,after.term_end_date],
    status: after.status, settled: after.payment_status, invoices: invoices.length,
    cashPaid: 91.28, credited: 65.20, total: after.total_with_vat,
    historicalClass: after.tier_label, protectedRecordsUnchanged: true, providerWrites: 0 }));
} catch (error) { await db.query('ROLLBACK').catch(()=>{}); throw error; }
finally { await db.end(); }
