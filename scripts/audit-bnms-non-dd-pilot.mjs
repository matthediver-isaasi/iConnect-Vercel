#!/usr/bin/env node
// Read-only pilot evidence. Deliberately has no apply mode before mapping review.
import { pathToFileURL } from 'node:url';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const MEMBER = 'd91d8aa3-4981-4ba0-b923-ab6ccb092f9f';
export const XERO_TENANT = '3d57dce6-2205-462f-abf6-9c7cbf00be23';

export async function auditPilot() {
  const db = await destinationConnection();
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const tenant = (await db.query('SELECT id,slug FROM tenant WHERE id=$1', [TENANT])).rows;
    if (tenant.length !== 1 || tenant[0].slug !== 'bnms') throw Error('BNMS identity mismatch');
    const members = (await db.query('SELECT id,email FROM member WHERE id=$1 AND tenant_id=$2', [MEMBER, TENANT])).rows;
    if (members.length !== 1) throw Error('Pilot member missing');
    const legacy = (await db.query(`SELECT f.name,v.value FROM member_preference_value v
      JOIN preference_field f ON f.id=v.field_id WHERE v.member_id=$1 AND f.tenant_id=$2
      AND f.name IN ('ym_web_site_member_id','membership_status','ym_date_membership_expires',
      'ym_membership_type','member_class','direct_debit_payment') ORDER BY f.name`, [MEMBER, TENANT])).rows;
    const histories = (await db.query(`SELECT id,membership_year,term_start_date,term_end_date,
      status,payment_method FROM member_membership_history WHERE tenant_id=$1 AND member_id=$2`, [TENANT, MEMBER])).rows;
    const ddCounts = {};
    for (const table of ['membership_billing_agreements', 'membership_payment_plans', 'gocardless_customers',
      'bnms_dd_alpha_adoption', 'bnms_dd_beta_adoption', 'bnms_dd_pilot_import', 'bnms_dd_historical_payment']) {
      ddCounts[table] = (await db.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 AND member_id=$2`, [TENANT, MEMBER])).rows[0].n;
    }
    ddCounts.discovery = (await db.query(`SELECT count(*)::int n FROM gocardless_mandate_discovery_row
      WHERE tenant_id=$1 AND matched_member_id=$2`, [TENANT, MEMBER])).rows[0].n;
    // Tokens remain in process memory only; never persist or log them.
    const tokens = (await db.query('SELECT tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1', [TENANT])).rows;
    if (tokens.length !== 1 || tokens[0].tenant_id !== XERO_TENANT
      || new Date(tokens[0].expires_at).getTime() <= Date.now()) throw Error('Fresh BNMS Xero connection required');
    const get = async (resource) => {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const response = await fetch(`https://api.xero.com/api.xro/2.0/${resource}`, {
        headers: { Authorization: `Bearer ${tokens[0].access_token}`, 'xero-tenant-id': XERO_TENANT, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw Error(`Xero lookup failed HTTP ${response.status}; no classification made`);
      return response.json();
    };
    const email = members[0].email?.trim().toLowerCase();
    if (!email) throw Error('Missing member email');
    const contacts = [];
    for (let page = 1; ; page++) {
      if (page > 100) throw Error('Contact pagination incomplete');
      const data = await get(`Contacts?where=${encodeURIComponent(`EmailAddress==${JSON.stringify(email)}`)}&page=${page}`);
      if (!Array.isArray(data.Contacts)) throw Error('Invalid contact response');
      contacts.push(...data.Contacts);
      if (data.Contacts.length < 100) break;
    }
    const matching = contacts.filter(c => c.EmailAddress?.trim().toLowerCase() === email);
    const report = { tenant: tenant[0], memberId: MEMBER, legacy, histories, ddCounts,
      contactCount: matching.length, writes: 0, classification: 'unreviewed', invoices: [] };
    report.contactCandidates = matching.map(c => ({
      id: c.ContactID, name: c.Name, status: c.ContactStatus, accountNumber: c.AccountNumber || null,
    }));
    const legacyIds = legacy.filter(p => p.name === 'ym_web_site_member_id');
    const exact = legacyIds.length === 1
      ? matching.filter(c => c.AccountNumber === legacyIds[0].value) : [];
    if (exact.length !== 1) return { ...report, blocker: 'Email plus legacy account number missing or ambiguous' };
    const contact = exact[0];
    if (matching.length > 1) report.blocker = 'Additional same-email contact requires review; latest invoice across identities not established';
    report.contact = { id: contact.ContactID, status: contact.ContactStatus,
      accountNumber: contact.AccountNumber || null };
    // Fetch paged metadata only. No PDFs or older invoice bodies are retained.
    const seen = new Set();
    for (let page = 1; ; page++) {
      if (page > 100) throw Error('Invoice pagination incomplete');
      const data = await get(`Invoices?where=${encodeURIComponent(`Contact.ContactID==Guid("${contact.ContactID}")&&Type=="ACCREC"`)}&order=Date%20DESC&page=${page}`);
      if (!Array.isArray(data.Invoices)) throw Error('Invalid invoice response');
      for (const invoice of data.Invoices) {
        if (seen.has(invoice.InvoiceID)) throw Error('Invoice paging drift');
        seen.add(invoice.InvoiceID);
        report.invoices.push({
          id: invoice.InvoiceID, number: invoice.InvoiceNumber, status: invoice.Status,
          date: invoice.DateString, paidOn: invoice.FullyPaidOnDate, reference: invoice.Reference,
          currency: invoice.CurrencyCode, total: invoice.Total, paid: invoice.AmountPaid,
          due: invoice.AmountDue, credited: invoice.AmountCredited,
          credits: invoice.CreditNotes?.length, prepayments: invoice.Prepayments?.length,
          overpayments: invoice.Overpayments?.length,
          lines: invoice.LineItems?.map(l => ({ description: l.Description, tracking: l.Tracking })),
          payments: invoice.Payments?.map(p => ({ id: p.PaymentID, date: p.Date, amount: p.Amount, reference: p.Reference })),
        });
      }
      if (data.Invoices.length < 100) break;
    }
    report.invoiceCountChecked = report.invoices.length;
    const paidMemberships = report.invoices.filter(i => i.status === 'PAID'
      && i.lines?.some(l => l.tracking?.some(t => t.Name === 'Projects' && t.Option === 'MEMBERSHIPS')));
    report.latestPaidMembershipCandidate = paidMemberships[0] || null;
    // Only the latest candidate leaves this audit; no older history is retained.
    delete report.invoices;
    return report;
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw Error('This audit accepts no flags and cannot apply changes');
  try { console.log(JSON.stringify(await auditPilot(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}