// Owner-authorised description-only correction. No invoice creation or payment writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './annual-meeting-destination.mjs';
import { recoveryIdentity } from '../api/_lib/eventInvoiceRecovery.js';
import { recoveryInvoiceMarker, eventInvoiceBookingReference } from '../api/_lib/eventInvoiceRecoveryXero.js';

const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const OPERATION = 'a4210a17-3631-4c18-9fc5-30b2df6bb497';
const INVOICE = '49bf0e7b-1575-4532-82ed-7a99adf85770';
const GROUP = 'OOE-1793016982039-C6JCW';
const XERO_TENANT = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (ok, code) => { if (!ok) throw Error(code); };

export function buildDescriptionRepair(invoice) {
  check(invoice.InvoiceID === INVOICE && invoice.InvoiceNumber === 'INV-9382'
    && invoice.Type === 'ACCREC' && ['AUTHORISED', 'PAID'].includes(invoice.Status)
    && invoice.CurrencyCode === 'GBP' && Number(invoice.Total) === 200
    && invoice.Contact?.ContactID && invoice.LineItems?.length > 0, 'invoice_scope_changed');
  const marker = recoveryInvoiceMarker(recoveryIdentity(TENANT, 'booking', GROUP));
  const first = invoice.LineItems[0].Description;
  check(typeof first === 'string' && first.endsWith(marker), 'expected_exact_marker_missing');
  const replacement = first.slice(0, -marker.length) + eventInvoiceBookingReference(GROUP);
  // Send every existing line with its ID, preserving provider-current financial
  // fields. Omitting another line in a Xero update would delete that line.
  const fields = ['LineItemID', 'Description', 'Quantity', 'UnitAmount', 'ItemCode',
    'AccountCode', 'TaxType', 'TaxAmount', 'LineAmount', 'DiscountRate', 'DiscountAmount', 'Tracking'];
  const lines = invoice.LineItems.map((line, index) => {
    check(line.LineItemID, 'line_identity_missing');
    const result = Object.fromEntries(fields.filter(key => Object.hasOwn(line, key)).map(key => [key, line[key]]));
    if (index === 0) result.Description = replacement;
    return result;
  });
  return { InvoiceID: INVOICE, LineAmountTypes: invoice.LineAmountTypes, LineItems: lines };
}

export function verifyDescriptionRepair(before, after, repair) {
  const invariant = invoice => {
    const copy = structuredClone(invoice);
    delete copy.UpdatedDateUTC;
    delete copy.UpdatedDateUTCString;
    // Only the first description is authorised to change.
    delete copy.LineItems[0].Description;
    return copy;
  };
  assert.deepEqual(invariant(after), invariant(before), 'provider_invoice_changed_beyond_description');
  check(after.LineItems[0].Description === repair.LineItems[0].Description, 'description_not_updated');
}

export async function main(args = process.argv.slice(2)) {
  const [mode, approvedHash] = args;
  check((mode === '--capture' && args.length === 1)
    || (mode === '--apply' && args.length === 2 && /^[a-f0-9]{64}$/.test(approvedHash)), 'invalid_arguments');
  const audit = await open(`/tmp/bnms-invoice-9382-${mode.slice(2)}.jsonl`, 'wx', 0o600);
  const record = async value => { await audit.writeFile(JSON.stringify(value) + '\n'); await audit.sync(); };
  let sql;
  try {
    sql = await connectDestination();
    await sql.query('BEGIN READ ONLY');
    await sql.query("SET LOCAL statement_timeout='8s'");
    const loadBinding = async () => {
      const result = await sql.query(`SELECT r.id,r.status,r.invoice_id,r.invoice_number,r.source,
        r.booking_group_reference,r.snapshot->'provider' AS provider,
        b.id AS booking_id,b.status AS booking_status,b.xero_invoice_id AS booking_invoice_id
        FROM event_invoice_recovery r JOIN booking b
          ON b.tenant_id=r.tenant_id AND b.booking_group_reference=r.booking_group_reference
        WHERE r.tenant_id=$1 AND r.id=$2`, [TENANT, OPERATION]);
      check(result.rows.length === 1, 'binding_cardinality');
      const r = result.rows[0];
      check(r.status === 'complete' && r.invoice_id === INVOICE && r.invoice_number === 'INV-9382'
        && r.source === 'booking' && r.booking_group_reference === GROUP
        && r.booking_status === 'confirmed' && r.booking_invoice_id === INVOICE
        && r.provider?.xeroTenantId === XERO_TENANT
        && r.provider.connectionId === 'cfcc622c-492c-440e-a7bc-1a5f4704c27e', 'binding_changed');
      return r;
    };
    const binding = await loadBinding();
    process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
    const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
    let auth;
    try { auth = await getValidXeroAccessToken(TENANT); }
    catch { throw Error('application_xero_authentication_failed'); }
    check(auth.tenantId === XERO_TENANT, 'provider_binding_changed');
    const request = async (suffix = '', method = 'GET', body = null) => {
      // Fixed invoice path: cannot create an invoice, alter a contact or pay.
      const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${INVOICE}${suffix}`, {
        method, headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': XERO_TENANT,
          Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      check(response.ok, `xero_http_${response.status}_do_not_blindly_retry`);
      const result = await response.json();
      check(!result.HasErrors && !result.ErrorNumber
        && !(result.Invoices || []).some(i => i.HasErrors || i.ValidationErrors?.length), 'xero_validation_failed');
      return result;
    };
    const readInvoice = async () => {
      const data = await request();
      check(data.Invoices?.length === 1 && data.Invoices[0].InvoiceID === INVOICE, 'invoice_cardinality');
      return data.Invoices[0];
    };
    const before = await readInvoice();
    const repair = buildDescriptionRepair(before);
    await record({ phase: 'capture', before, binding, hash: hash(before) });
    if (mode === '--capture') {
      console.log(JSON.stringify({ invoice: before.InvoiceNumber, hash: hash(before), status: before.Status,
        total: before.Total, paid: before.AmountPaid, due: before.AmountDue,
        change: 'Replace exact recovery suffix with normal booking reference', writes: 0 }));
      return;
    }
    const saved = JSON.parse((await readFile('/tmp/bnms-invoice-9382-capture.jsonl', 'utf8')).split('\n')[0]);
    check(hash(saved.before) === approvedHash && hash(before) === approvedHash, 'captured_invoice_changed');
    assert.deepEqual(saved.binding, binding);
    // Re-read immediately before the one authorised write. Xero does not offer
    // conditional updates; any observed drift stops the correction.
    check(hash(await readInvoice()) === approvedHash, 'invoice_changed_before_write');
    await record({ phase: 'write_intent', repair });
    await request('', 'POST', { Invoices: [repair] });
    const after = await readInvoice();
    await record({ phase: 'postflight', after });
    verifyDescriptionRepair(before, after, repair);
    assert.deepEqual(await loadBinding(), binding);
    await record({ phase: 'verified', at: new Date().toISOString() });
    await request('/History', 'PUT', { HistoryRecords: [{
      Details: 'Removed internal event recovery label from invoice description; retained booking reference. Amounts, tax, contact, invoice number and payments unchanged.',
    }] });
    console.log(JSON.stringify({ invoice: after.InvoiceNumber, status: 'description_corrected',
      total: after.Total, paid: after.AmountPaid, due: after.AmountDue,
      financialAndPaymentFieldsUnchanged: true, localBookingAndRecoveryWrites: 0 }));
  } finally {
    if (sql) { await sql.query('ROLLBACK'); await sql.end(); }
    await audit.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Do not print provider payloads, credential errors or assertion values.
    console.error('Invoice correction stopped. Inspect the private audit before any retry.');
    process.exitCode = 1;
  });
}
