// Explicitly authorised customer/detail correction. Never creates invoices or payments.
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination, PROJECT } from './annual-meeting-destination.mjs';
import { TENANT, XERO_TENANT, hash } from './prepare-bnms-paid-invoice-renumber.mjs';

const INVOICE = '114acb56-e37e-4d9b-ade0-9f98255002f3';
const GROUP = 'OOE-1790198918339-82WJL';
const RECOVERY = '8126f3a8-fd0d-4b6d-95ee-adda6af98ad9';
const requireThat = (condition, code) => { if (!condition) throw Error(code); };
export function invoiceInvariant(invoice) {
  const result = structuredClone(invoice);
  delete result.UpdatedDateUTC;
  delete result.UpdatedDateUTCString;
  // Name/email may be expanded from the corrected contact; its ID cannot change.
  result.Contact = { ContactID: invoice.Contact?.ContactID };
  result.LineItems = result.LineItems.map(line => {
    delete line.Description;
    return line;
  });
  return result;
}
export function buildRepair(evidence) {
  const { booking: b, recovery: r, invoice: i, contact: c, event: e } = evidence;
  requireThat(i.InvoiceID === INVOICE && i.InvoiceNumber === 'INV-8958'
    && i.Type === 'ACCREC' && i.Status === 'AUTHORISED' && i.CurrencyCode === 'GBP'
    && i.Total === 200 && i.SubTotal === 166.67 && i.TotalTax === 33.33
    && i.AmountPaid === 166.67 && i.AmountDue === 33.33 && i.LineAmountTypes === 'Exclusive'
    && i.Payments?.length === 1 && i.Payments[0].Amount === 166.67
    && i.Payments[0].PaymentID === '0c22c60b-56c5-4a68-a952-a493bd9cf9f5',
  'current_live_financial_state_changed');
  requireThat(b.tenant_id === TENANT && r.tenant_id === TENANT && r.id === RECOVERY
    && b.booking_group_reference === GROUP && r.booking_group_reference === GROUP
    && b.xero_invoice_id === INVOICE && r.invoice_id === INVOICE
    && b.xero_invoice_number === 'INV-8958' && r.invoice_number === 'INV-8958'
    && r.status === 'complete' && !r.lease_token && !r.lease_expires_at
    && b.payment_method === 'card' && b.status === 'confirmed'
    && b.stripe_payment_intent_id === r.settlement_payment_intent_id
    && r.snapshot.settlement?.livemode === true && r.snapshot.settlement?.captured === true
    && r.snapshot.settlement.paymentIntentId === b.stripe_payment_intent_id
    && r.snapshot.contact?.provenance?.kind === 'historical_guest_verified_stripe_payer'
    && c.ContactID === i.Contact.ContactID, 'local_provider_binding_failed');
  const email = String(r.snapshot.contact.email || '').trim().toLowerCase();
  requireThat(email && email === String(b.attendee_email || '').trim().toLowerCase()
    && email === String(c.EmailAddress || '').trim().toLowerCase(),
  'payer_attendee_contact_email_mismatch');
  const name = [b.attendee_first_name, b.attendee_last_name].filter(Boolean).join(' ').trim();
  requireThat(name && name === 'Tejas Ingle' && e.id === b.event_id && e.tenant_id === TENANT
    && e.name && b.ticket_class_name && i.LineItems.length === 1, 'booking_description_evidence_missing');
  requireThat([email, name].includes(c.Name), 'unexpected_contact_name');
  const description = [
    i.LineItems[0].Description,
    `Event: ${e.name}`,
    `Booking reference: ${GROUP}`,
    `Customer: ${name} — ${email}`,
    `Ticket: ${b.ticket_class_name}`,
    `Attendee: ${name} — ${b.attendee_email}`,
    b.guest_organisation_name ? `Attendee organisation: ${b.guest_organisation_name}` : null,
    'Card payment received: GBP 166.67.',
  ].filter(Boolean).join('\n');
  return {
    contact: { ContactID: c.ContactID, Name: `${name} (${email})`, FirstName: b.attendee_first_name,
      LastName: b.attendee_last_name, EmailAddress: email },
    invoice: { InvoiceID: INVOICE, LineItems: i.LineItems.map(line => ({
      ...line, Description: description,
    })) },
  };
}

export async function session() {
  const db = await connectDestination();
  requireThat(process.env.DEST_SUPABASE_URL === `https://${PROJECT}.supabase.co`, 'destination_pin');
  // Must precede application imports: never read SOURCE credentials.
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
  const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
  const auth = await getValidXeroAccessToken(TENANT);
  requireThat(auth.tenantId === XERO_TENANT, 'provider_tenant_pin');
  const request = async (path, method = 'GET', payload) => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': XERO_TENANT,
        Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const result = await response.json();
    requireThat(response.ok, `provider_http_${response.status}_no_retry: ${JSON.stringify(
      (result.Elements || []).flatMap(e => e.ValidationErrors || []).map(e => e.Message))}`);
    requireThat(!result.HasErrors && !result.Invoices?.some(i => i.HasErrors)
      && !result.Contacts?.some(c => c.HasValidationErrors), 'provider_validation_failure');
    return result;
  };
  return { db, request };
}
async function capture(db, request) {
  const one = async (sql, values) => {
    const { rows } = await db.query(sql, values);
    requireThat(rows.length === 1, 'local_cardinality');
    return rows[0].row;
  };
  const booking = await one(`SELECT to_jsonb(b) - 'check_in_token' - 'confirmation_token' row
    FROM booking b WHERE tenant_id=$1 AND booking_group_reference=$2`, [TENANT, GROUP]);
  const recovery = await one('SELECT to_jsonb(r) row FROM event_invoice_recovery r WHERE tenant_id=$1 AND id=$2', [TENANT, RECOVERY]);
  const event = await one('SELECT jsonb_build_object(\'id\',id,\'tenant_id\',tenant_id,\'name\',title) row FROM event WHERE tenant_id=$1 AND id=$2', [TENANT, booking.event_id]);
  const invoices = (await request(`Invoices/${INVOICE}`)).Invoices;
  requireThat(invoices?.length === 1, 'provider_invoice_cardinality');
  const invoice = invoices[0];
  const contacts = (await request(`Contacts/${invoice.Contact.ContactID}`)).Contacts;
  requireThat(contacts?.length === 1, 'provider_contact_cardinality');
  const contact = contacts[0];
  // A name repair must not silently rename another customer's invoice.
  const related = (await request(`Invoices?${new URLSearchParams({
    where: `Contact.ContactID==Guid("${contact.ContactID}")`, page: '1',
  })}`)).Invoices;
  requireThat(related?.length === 1 && related[0].InvoiceID === INVOICE, 'shared_contact_requires_review');
  return { booking, recovery, event, invoice, contact };
}

export async function main(args = process.argv.slice(2)) {
  const [mode, output, evidencePath, approvedHash] = args;
  requireThat(['--capture', '--apply'].includes(mode)
    && /^\/tmp\/bnms-invoice-8958-[a-z0-9-]+\.jsonl$/.test(output || '')
    && (mode === '--capture' ? args.length === 2
      : args.length === 4 && /^\/tmp\/bnms-invoice-8958-[a-z0-9-]+\.jsonl$/.test(evidencePath)
        && /^[a-f0-9]{64}$/.test(approvedHash)), 'invalid_arguments');
  const audit = await open(output, 'wx', 0o600);
  const record = async value => { await audit.writeFile(`${JSON.stringify(value)}\n`); await audit.sync(); };
  let db;
  try {
    const s = await session(); db = s.db;
    await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL statement_timeout='10s'");
    const before = await capture(db, s.request);
    await record({ phase: 'capture', before, hash: hash(before) });
    const repair = buildRepair(before);
    await record({ phase: 'preflight', at: new Date().toISOString(), before, repair, hash: hash(before) });
    if (mode === '--apply') {
      const saved = JSON.parse((await readFile(evidencePath, 'utf8')).split('\n')[0]);
      requireThat(hash(saved.before) === approvedHash && hash(before) === approvedHash, 'evidence_changed');
      await record({ phase: 'contact_write_intent', repair: repair.contact });
      const updated = await s.request(`Contacts/${repair.contact.ContactID}`, 'POST', { Contacts: [repair.contact] });
      await record({ phase: 'contact_response', result: updated });
      await record({ phase: 'invoice_write_intent', repair: repair.invoice });
      await record({ phase: 'invoice_response', result: await s.request(`Invoices/${INVOICE}`, 'POST', { Invoices: [repair.invoice] }) });
      const after = await capture(db, s.request);
      await record({ phase: 'postflight', after });
      requireThat(hash(invoiceInvariant(before.invoice)) === hash(invoiceInvariant(after.invoice))
        && after.contact.Name === repair.contact.Name && after.contact.EmailAddress === repair.contact.EmailAddress
        && after.invoice.LineItems[0].Description === repair.invoice.LineItems[0].Description
        && hash(before.booking) === hash(after.booking) && hash(before.recovery) === hash(after.recovery),
      'postflight_invariant_failed_do_not_retry');
      await record({ phase: 'verified', at: new Date().toISOString() });
      console.log('Existing invoice corrected; financial/payment invariants unchanged; no local booking/recovery writes.');
    } else {
      console.log(JSON.stringify({ hash: hash(before), invoice: before.invoice.InvoiceNumber,
        currentName: before.contact.Name, proposedName: repair.contact.Name,
        description: repair.invoice.LineItems[0].Description, total: before.invoice.Total }));
    }
    await db.query('ROLLBACK');
  } finally { if (db) await db.end(); await audit.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
