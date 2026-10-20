// Offline proposal only. Deliberately has no database, provider or apply path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const MEMBERS = [
  '1ab1438d-ddee-49b3-a8fe-b51722c2dbbe',
  'de5730b6-ff54-489b-aeb3-9b4c4595e8aa',
  '2fcd2ba5-1beb-4ee0-9470-b87d3dcd8158',
  'f514de89-2d72-4109-86a5-27bb7e71118b',
  '3a7013f3-bafb-4afa-92d6-d7eefc73e21e',
];
const SOURCE = 'bnms_five_member_reconstruction_v1';
const FORMER = MEMBERS[3];
const HISTORY_SHA = 'eb6939e0e1d88357a54a988d9238f49ac1fb706d62643f8b61ea8f9d6560dc8c';
const SOURCE_SELECTION = {
  [MEMBERS[0]]: [352, 'Full Membership DD', '2026-07-30', null],
  [MEMBERS[1]]: [3949, 'Trainee Membership UK', '2026-02-26', '2027-01-31'],
  [MEMBERS[2]]: [1932, 'LMIC Membership', '2026-01-14', '2027-01-12'],
  [MEMBERS[3]]: [175, 'Junior Membership UK', '2021-02-18', '2026-08-25'],
  [MEMBERS[4]]: [3661, 'Full Membership UK', '2026-02-17', '2027-02-17'],
};
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function historyId(memberId) {
  assert.ok(MEMBERS.includes(memberId), 'Member outside approved scope');
  const h = hash(`${SOURCE}:${memberId}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function isoDate(value) {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(value || ''), 'Missing/invalid ISO date');
  assert.equal(new Date(`${value}T00:00:00Z`).toISOString().slice(0,10), value, 'Invalid date');
  return value;
}
export function legacyExpiry(value) {
  if (!value) return null;
  assert.ok(/^\d{2}\/\d{2}\/\d{4}$/.test(value), 'Ambiguous legacy expiry');
  return isoDate(`${value.slice(6)}-${value.slice(3,5)}-${value.slice(0,2)}`);
}
function preference(evidence, name) {
  const found = evidence.prefs.filter(p => p.name === name);
  assert.ok(found.length <= 1, `Duplicate ${name}`);
  return found[0]?.value || null;
}
function money(value) {
  assert.equal(typeof value, 'number', 'Missing numeric financial evidence');
  assert.ok(Number.isFinite(value) && value >= 0, 'Invalid financial evidence');
  return Math.round(value * 100);
}
function verifiedInvoice(evidence, decision) {
  const selected = evidence.invoices.filter(i => i.InvoiceID === decision.invoiceId);
  assert.equal(selected.length, 1, 'Selected invoice missing or duplicated');
  const invoice = selected[0];
  const contact = evidence.contacts.find(c => c.ContactID === invoice.Contact?.ContactID);
  assert.ok(contact, 'Invoice contact not captured');
  // Alternate contact identities must be separately reviewed, never matched by name.
  assert.equal(decision.contactId, contact.ContactID, 'Contact binding changed');
  const emailMatch = String(contact.EmailAddress || '').trim().toLowerCase()
    === String(evidence.member.email || '').trim().toLowerCase();
  const account = preference(evidence, 'ym_web_site_member_id');
  const accountMatch = !!account && contact.AccountNumber === account;
  assert.ok((emailMatch && !!evidence.member.email) || accountMatch
    || (decision.identityAuthority === 'operator_verified_alternate_contact'
      && typeof decision.identityEvidence === 'string' && decision.identityEvidence.trim().length > 10),
  'Unverified invoice identity');
  assert.equal(invoice.Type, 'ACCREC', 'Not a sales invoice');
  assert.equal(invoice.Status, 'PAID', 'Invoice is not settled');
  assert.equal(invoice.CurrencyCode, 'GBP', 'Unexpected invoice currency');
  assert.ok(invoice.LineItems?.length, 'Missing invoice lines');
  assert.ok(invoice.LineItems.every(line => /membership/i.test(line.Description || '')),
    'Mixed/non-membership invoice requires separate review');
  assert.equal(decision.invoiceNumber, invoice.InvoiceNumber, 'Invoice number changed');
  assert.equal(money(invoice.AmountDue), 0);
  assert.equal(money(invoice.AmountPaid), money(invoice.Total), 'Credits/write-offs are not payments');
  assert.ok(money(invoice.Total) > 0);
  assert.equal(money(invoice.AmountCredited ?? 0), 0, 'Credited invoice');
  assert.equal((invoice.CreditNotes || []).length, 0, 'Invoice has credit notes');
  assert.equal((invoice.Overpayments || []).length, 0, 'Overpayments require review');
  assert.equal((invoice.Prepayments || []).length, 0, 'Prepayments require review');
  assert.ok(invoice.Payments?.length, 'No independently verified payments');
  assert.ok(Array.isArray(decision.payments), 'Verified payment details required');
  assert.equal(new Set(decision.payments.map(p => p.PaymentID)).size, decision.payments.length);
  assert.deepEqual(decision.payments.map(p => p.PaymentID).sort(),
    invoice.Payments.map(p => p.PaymentID).sort(), 'Incomplete payment verification');
  let total = 0;
  for (const payment of decision.payments) {
    assert.equal(payment.Invoice?.InvoiceID, invoice.InvoiceID, 'Payment invoice mismatch');
    assert.equal(payment.Status, 'AUTHORISED', 'Payment not authorised');
    assert.ok(money(payment.Amount) > 0);
    total += money(payment.Amount);
    const summary = invoice.Payments.find(p => p.PaymentID === payment.PaymentID);
    assert.equal(money(summary.Amount), money(payment.Amount), 'Payment amount changed');
  }
  assert.equal(total, money(invoice.Total), 'Payment total mismatch');
  assert.equal(money(invoice.SubTotal) + money(invoice.TotalTax), money(invoice.Total));
  return invoice;
}

// Decisions contain reviewed evidence only, not a blanket approval or a pricing schedule.
// Missing expiry blocks that member; invoice dates never become commencement dates.
export function prepareProposal(evidence, decisions, asOf, sourceRows = []) {
  isoDate(asOf);
  assert.equal(evidence.length, MEMBERS.length);
  assert.deepEqual(evidence.map(e => e.member.id).sort(), [...MEMBERS].sort());
  assert.ok(Array.isArray(decisions));
  assert.equal(new Set(decisions.map(d => d.memberId)).size, decisions.length);
  assert.ok(decisions.every(d => MEMBERS.includes(d.memberId)), 'Decision outside scope');
  const rows = [], blocked = [];
  for (const memberId of MEMBERS) {
    const e = evidence.find(item => item.member.id === memberId);
    if (e.member.tenant_id != null) assert.equal(e.member.tenant_id, TENANT);
    const d = decisions.find(item => item.memberId === memberId) || {};
    let expiry = legacyExpiry(preference(e, 'ym_date_membership_expires'));
    let start = null, sourceMembership = null, sourcePin = null;
    if (sourceRows.length) {
      const [row, membership, expectedStart, expectedEnd] = SOURCE_SELECTION[memberId];
      const found = sourceRows.filter(s => s.sha256 === HISTORY_SHA && s.row === row
        && s.data?.['iConnect UUID'] === memberId);
      assert.equal(found.length, 1, 'Pinned history source row missing/duplicated');
      const s = found[0];
      sourceMembership = s.data['Membership History - Membership'];
      assert.equal(sourceMembership, membership, 'Source membership changed');
      const sourceDate = key => {
        const value = s.data[key];
        if (value == null || value === '') return null;
        assert.ok(/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(value), 'Ambiguous spreadsheet date');
        return isoDate(value.slice(0,10));
      };
      start = sourceDate('Membership History - Membership Start Date');
      const end = sourceDate('Membership History - Membership End Date');
      assert.equal(start, expectedStart);
      assert.equal(end, expectedEnd);
      if (expiry) assert.equal(end, expiry, 'History and retained expiry disagree');
      expiry = end;
      sourcePin = { file: s.file, sheet: s.sheet, row: s.row, sha256: s.sha256, rowHash: hash(s.data) };
      if (memberId === FORMER) {
        assert.ok(sourceRows.some(s => s.sha256 === HISTORY_SHA && s.row === 162
          && s.data?.['iConnect UUID'] === memberId
          && s.data['Membership History - Membership'] === 'Guest'
          && s.data['Membership History - Membership Start Date'] === '2026-08-26 00:00:00'),
        'Former member Guest transition missing');
      }
    }
    if (!expiry && !start) {
      blocked.push({ memberId, reason: 'No retained legacy expiry; invoice date is not term authority' });
      continue;
    }
    const tier = preference(e, 'member_class');
    assert.ok(tier, 'Missing evidenced member class');
    const invoice = d.invoiceId ? verifiedInvoice(e, d) : null;
    const notes = {
      source: SOURCE, scope: 'historical_reconstruction_only', evidenceHash: hash(e),
      startDateAuthority: sourcePin ? 'pinned_original_membership_history' : 'unknown_not_inferred',
      expiryAuthority: expiry ? 'retained_legacy_expiry_and_or_pinned_history' : 'unknown_not_inferred',
      ...(sourcePin ? { sourcePin, sourceMembership } : {}),
      paymentAuthority: invoice ? 'verified_existing_xero_payments' : 'unknown_not_inferred',
      invoiceAuthority: invoice ? 'verified_existing_membership_invoice' : 'not_verified_not_linked',
      futureCollectionConsent: false, renewalAuthority: false, memberRoleChange: false,
      formerMember: memberId === FORMER,
      ...(invoice ? { invoiceId: invoice.InvoiceID, paymentIds: d.payments.map(p => p.PaymentID).sort(),
        identityAuthority: d.identityAuthority || 'matching_email_or_legacy_account',
        ...(d.identityEvidence ? { identityEvidence: d.identityEvidence } : {}) } : {}),
    };
    rows.push({
      id: historyId(memberId), tenant_id: TENANT, member_id: memberId,
      membership_year: start ? `Legacy membership from ${start}` : 'Legacy membership (start unknown)',
      tier_label: sourceMembership || tier,
      config_id: null, term_start_date: start, term_end_date: expiry,
      membership_renewal_date: null, term_key: null,
      // Display-only original dates. No duration, renewal, schedule or collection snapshot.
      commitment_snapshot: { source: SOURCE, term_start_date: start, term_end_date: expiry,
        structure_name: sourceMembership || tier },
      billing_agreement_id: null, payment_method: null, payment_frequency: null,
      // Former status is never upgraded, even if a future expiry is discovered.
      status: memberId === FORMER || (expiry && expiry < asOf) ? 'expired' : 'active',
      payment_status: invoice ? 'paid' : null, paid_at: null,
      billing_period: null, currency: invoice ? invoice.CurrencyCode : null,
      annual_cost: null, prorata_cost: null, free_period_discount: null,
      rollover_discount: null, custom_discount_total: null,
      final_cost: invoice ? invoice.SubTotal : null,
      vat_amount: invoice ? invoice.TotalTax : null,
      total_with_vat: invoice ? invoice.Total : null,
      accounting_provider: invoice ? 'xero' : null,
      accounting_invoice_id: invoice?.InvoiceID || null,
      accounting_invoice_number: invoice?.InvoiceNumber || null,
      xero_invoice_id: invoice?.InvoiceID || null,
      xero_invoice_number: invoice?.InvoiceNumber || null,
      notes: JSON.stringify(notes),
    });
  }
  assert.equal(new Set(rows.filter(r => r.xero_invoice_id).map(r => r.xero_invoice_id)).size,
    rows.filter(r => r.xero_invoice_id).length, 'Invoice reused');
  return { source: SOURCE, tenant: TENANT, asOf, evidenceHash: hash(evidence),
    decisionsHash: hash(decisions), sourceRowsHash: hash(sourceRows), rows, blocked, productionWrites: 0,
    requiresBeforeApply: [
      'Owner review of exact rows and invoice-to-retained-term association',
      'Fresh tenant-scoped DB snapshot, schema/default/constraint and all trigger review',
      'Fresh read-only Xero identity, invoice, payment and credit verification',
      'Serializable transaction; tenant and member locks; global invoice reuse checks',
      'Protected-table snapshots; no roles/preferences/plans/agreements/renewal authority changes',
      'Validated rolled-back insert rehearsal; explicit approval pinned to evidence and rows',
    ] };
}

// A future transactional runner must use this check rather than ON CONFLICT DO NOTHING.
export function planIdempotentInserts(rows, existing) {
  const pending = [], replayed = [];
  for (const row of rows) {
    const sameId = existing.filter(r => r.id === row.id);
    assert.ok(sameId.length <= 1, 'Duplicate history ID');
    const other = existing.filter(r => r.tenant_id === TENANT
      && r.member_id === row.member_id && r.id !== row.id);
    assert.equal(other.length, 0, 'Other history exists; re-review instead of duplicating');
    if (row.xero_invoice_id) {
      assert.ok(!existing.some(r => r.id !== row.id
        && [r.xero_invoice_id, r.accounting_invoice_id].includes(row.xero_invoice_id)),
      'Invoice already linked');
    }
    if (sameId.length) {
      for (const [key, value] of Object.entries(row)) {
        assert.deepEqual(sameId[0][key], value, `Existing repair changed: ${key}`);
      }
      replayed.push(row.id);
    } else pending.push(row);
  }
  return { pending, replayed };
}

export async function main(args = process.argv.slice(2)) {
  const [mode, evidencePath, decisionsPath, asOf, output, sourcePath] = args;
  assert.ok(mode === '--prepare' && [5,6].includes(args.length), 'Only offline --prepare is supported');
  assert.ok(output?.startsWith('/tmp/') && output.endsWith('.json'), 'Private /tmp JSON output required');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
  const sourceRows = sourcePath ? JSON.parse(await readFile(sourcePath, 'utf8')) : [];
  const proposal = prepareProposal(evidence, decisions, asOf, sourceRows);
  await writeFile(output, JSON.stringify(proposal, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ proposed: proposal.rows.length, blocked: proposal.blocked.length,
    proposalHash: hash(proposal), productionWrites: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
