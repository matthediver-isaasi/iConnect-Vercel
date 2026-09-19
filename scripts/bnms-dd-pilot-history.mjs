// Transactional historical-only import. Does not enable or schedule collections.
import { createHash } from 'node:crypto';
import { MEMBER_ID, TENANT_ID, MANDATE_ID, CUSTOMER_ID, MONTHS, WORKBOOK_SHA256, assertPilot } from './bnms-dd-pilot.mjs';

export const STRUCTURE_ID = '07f35246-907a-411d-be78-2b3a9587ce3a';
const CONTACT_ID = '3e69cfdf-4d7c-4d70-9630-aa68f8c8fced';
const XERO_TENANT_ID = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
const reject = (message) => { throw new Error(message); };
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const minor = value => Math.round(Number(value) * 100);

export function historicalManifest(evidence) {
  assertPilot(evidence?.member?.id);
  if (evidence.member.tenant_id !== TENANT_ID || evidence.classes?.length !== 1
      || evidence.classes[0].value !== 'Full with NMC') reject('Member/class evidence mismatch');
  if (evidence.invoices?.length !== 9 || evidence.providerPayments?.length !== 9) reject('Nine complete invoice/payment pairs required');
  const rows = MONTHS.map(period => {
    const matches = evidence.invoices.filter(i => i.DateString?.slice(0, 10) === period);
    if (matches.length !== 1) reject(`Ambiguous invoice period ${period}`);
    const i = matches[0];
    // Xero's single-invoice endpoint omits AmountCredited when it is zero,
    // unlike the contact-filtered list response. Infer zero ONLY from the
    // explicit full cash payment, zero balance and absence of credit notes.
    const noCredits = Object.hasOwn(i, 'AmountCredited')
      ? i.AmountCredited !== null && Number(i.AmountCredited) === 0
      : minor(i.Total) === 1304 && minor(i.AmountPaid) === 1304
        && i.AmountDue !== null && Number(i.AmountDue) === 0 && !i.CreditNotes?.length;
    if (i.Contact?.ContactID !== CONTACT_ID || i.Type !== 'ACCREC' || i.Status !== 'PAID'
        || i.CurrencyCode !== 'GBP' || minor(i.Total) !== 1304 || minor(i.AmountPaid) !== 1304
        || Number(i.AmountDue) !== 0 || !noCredits
        || i.CreditNotes?.length || i.Prepayments?.length || i.Overpayments?.length
        || i.Payments?.length !== 1 || i.LineItems?.length !== 1
        || i.LineItems[0].AccountCode !== '200' || !i.InvoiceID || !i.InvoiceNumber) reject(`Invoice evidence conflict ${period}`);
    const xp = i.Payments[0];
    const payments = evidence.providerPayments.filter(p => p.id === xp.Reference);
    if (payments.length !== 1) reject(`Provider payment identity conflict ${period}`);
    const p = payments[0];
    if (p.links?.mandate !== MANDATE_ID || p.links?.creditor !== 'CR0000B50W1Y2R'
        || p.status !== 'paid_out' || p.amount !== 1304 || p.currency !== 'GBP'
        || p.amount_refunded !== 0 || minor(xp.Amount) !== 1304
        || p.metadata?.['Invoice number'] !== i.InvoiceNumber || !xp.PaymentID
        || !/^\d{4}-\d{2}-\d{2}$/.test(p.charge_date)
        || p.charge_date.slice(0, 7) !== period.slice(0, 7)) reject(`Provider settlement conflict ${period}`);
    return { period, charge_date: p.charge_date, amount_minor: 1304, currency: 'GBP',
      provider_payment_id: p.id, provider_status: p.status, xero_invoice_id: i.InvoiceID,
      xero_invoice_number: i.InvoiceNumber, xero_payment_id: xp.PaymentID,
      evidence: { invoice: i, providerPayment: p } };
  });
  for (const key of ['provider_payment_id', 'xero_invoice_id', 'xero_payment_id']) {
    if (new Set(rows.map(r => r[key])).size !== 9) reject(`Duplicate ${key}`);
  }
  return { version: 1, tenantId: TENANT_ID, memberId: MEMBER_ID, structureId: STRUCTURE_ID,
    mandateId: MANDATE_ID, customerId: CUSTOMER_ID, xeroTenantId: XERO_TENANT_ID,
    workbookSha256: WORKBOOK_SHA256, approvedMonthlyAmountMinor: 1300,
    nominatedDay: 1, firstManagedCollection: '2026-10-01', historicalOnly: true, rows };
}

// Caller supplies a destination-pinned pg client, never an application/provider client.
// Both apply and resume enter this same transaction. There is no partial commit path.
export async function importHistoricalPilot(client, evidence, { apply = false, reviewSha256, verifiedDestination = false } = {}) {
  const manifest = historicalManifest(evidence);
  const hash = fingerprint(manifest);
  if (apply && (!verifiedDestination || reviewSha256 !== hash)) reject('Verified destination and exact reviewed evidence hash required');
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bnms-dd-pilot-4533'))");
    // Block concurrent canonical writes until the collision check and import
    // commit together. DB triggers protect subsequent canonical replays.
    await client.query('LOCK TABLE gocardless_payments, member_membership_history IN SHARE ROW EXCLUSIVE MODE');
    const { rows: members } = await client.query('SELECT id FROM member WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [MEMBER_ID, TENANT_ID]);
    if (members.length !== 1) reject('Pinned destination member missing');
    const { rows: structures } = await client.query(
      `SELECT id FROM membership_tier_config WHERE id=$1 AND tenant_id=$2 AND is_active=true
       AND structure_scope_type='member' AND structure_match_value='Full with NMC'
       AND currency='GBP' AND dd_monthly_amount=13 FOR SHARE`, [STRUCTURE_ID, TENANT_ID]);
    if (structures.length !== 1) reject('Approved structure drift');
    const { rows: classes } = await client.query(
      `SELECT v.value FROM member_preference_value v JOIN preference_field f ON f.id=v.field_id
       WHERE v.member_id=$1 AND f.tenant_id=$2 AND f.name='member_class' AND f.entity_scope='member'
       AND f.is_active=true FOR SHARE OF v,f`, [MEMBER_ID, TENANT_ID]);
    if (classes.length !== 1 || classes[0].value !== 'Full with NMC') reject('Current member class drift');
    const prior = await client.query('SELECT * FROM bnms_dd_pilot_import WHERE member_id=$1 FOR UPDATE', [MEMBER_ID]);
    if (prior.rows.length) {
      if (prior.rows[0].evidence_sha256 !== hash) reject('Existing immutable evidence differs');
      const saved = await client.query('SELECT evidence FROM bnms_dd_historical_payment WHERE import_id=$1 ORDER BY period', [prior.rows[0].id]);
      if (saved.rows.length !== 9 || saved.rows.some((r, i) => fingerprint(r.evidence) !== fingerprint(manifest.rows[i].evidence))) reject('Incomplete or conflicting prior import');
      await client.query('ROLLBACK');
      return { mode: 'replay', writes: 0, historicalRows: 9, hash };
    }
    // Never duplicate existing canonical provider payments or invoice associations.
    const collisions = await client.query(
      `SELECT id FROM gocardless_payments WHERE gocardless_payment_id = ANY($1::text[])
       UNION ALL SELECT id FROM member_membership_history WHERE tenant_id=$2 AND
       (xero_invoice_id::text = ANY($3::text[]) OR accounting_invoice_id::text = ANY($3::text[]))`,
      [manifest.rows.map(r => r.provider_payment_id), TENANT_ID, manifest.rows.map(r => r.xero_invoice_id)]);
    if (collisions.rows.length) reject('Existing canonical payment/invoice requires reconciliation');
    if (!apply) {
      await client.query('ROLLBACK');
      return { mode: 'dry_run', writes: 0, plannedHistoricalRows: 9, hash, manifest };
    }
    const inserted = await client.query(
      `INSERT INTO bnms_dd_pilot_import (tenant_id,member_id,structure_id,mandate_id,customer_id,evidence_sha256,evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [TENANT_ID, MEMBER_ID, STRUCTURE_ID, MANDATE_ID, CUSTOMER_ID, hash, manifest]);
    for (const row of manifest.rows) {
      await client.query(
        `INSERT INTO bnms_dd_historical_payment
         (import_id,tenant_id,member_id,period,charge_date,amount_minor,currency,provider_payment_id,
          provider_status,xero_invoice_id,xero_invoice_number,xero_payment_id,evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [inserted.rows[0].id, TENANT_ID, MEMBER_ID, row.period, row.charge_date, row.amount_minor,
          row.currency, row.provider_payment_id, row.provider_status, row.xero_invoice_id,
          row.xero_invoice_number, row.xero_payment_id, row.evidence]);
    }
    await client.query('COMMIT');
    return { mode: 'historical_only_apply', writes: 10, historicalRows: 9, hash,
      liveCollectionEnabled: false, membershipActivated: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}