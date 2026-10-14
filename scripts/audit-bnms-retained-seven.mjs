// Read-only, bounded evidence refresh. No repair mode exists: approval is pending.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {connectDestination} from './lib/member-index-destination.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';

const root = 'generated-artifacts/bnms-nmc-25-evidence';
const out = 'generated-artifacts/bnms-retained-seven';
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const hash = x => createHash('sha256').update(x).digest('hex');
const read = name => JSON.parse(fs.readFileSync(`${root}/${name}.json`));
async function main() {
  assert.equal(process.argv.length, 2, 'Read-only audit accepts no arguments');
  const bytes = fs.readFileSync(`${root}/proposal.json`);
  assert.equal(hash(bytes), '4863739b20eab5685be3cf03fe67238d795aff5bd029c4c133739d52bf4b7827');
  const rows = JSON.parse(bytes).rows.filter(r => r.category === 'Retain expiry: resolve historical membership evidence');
  assert.equal(rows.length, 7);
  const ids = rows.map(r => r.memberId);
  assert.equal(new Set(ids).size, 7);
  const snapshot = read('snapshot'), sources = read('sources').rows, oldProviders = read('members');
  for (const row of rows) {
    const source = sources.find(s => s.memberId === row.memberId);
    assert.equal(source.expiry, row.retainedExpiry);
    assert.equal(source.sourceState, 'source_fields_corroborated');
    for (const match of source.matches) {
      assert.equal(hash(fs.readFileSync(match.file)), match.fileSha256, 'Original source changed');
      assert.equal(match.identityConflict, false);
      assert.equal(match.entitlementFieldsAgree, true);
    }
  }
  destinationTarget(process.env);
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
  const {SOURCE_SQL} = await import('./bnms-non-dd-apply.mjs');
  const db = await connectDestination();
  let live;
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL statement_timeout='60s'");
    live = {source: (await db.query(SOURCE_SQL, [tenant])).rows.filter(r => ids.includes(r.id))};
    for (const [key, table, column] of [
      ['members','member','id'], ['histories','member_membership_history','member_id'],
      ['agreements','membership_billing_agreements','member_id'], ['plans','membership_payment_plans','member_id'],
    ]) {
      live[key] = (await db.query(`SELECT to_jsonb(r) data FROM ${table} r WHERE tenant_id=$1 AND ${column}=ANY($2::uuid[]) ORDER BY id`, [tenant, ids])).rows.map(r => r.data);
    }
    live.payments = (await db.query(`SELECT to_jsonb(r) data FROM gocardless_payments r
      WHERE tenant_id=$1 AND plan_id IN (SELECT id FROM membership_payment_plans WHERE tenant_id=$1 AND member_id=ANY($2::uuid[]))
      ORDER BY gocardless_payment_id`, [tenant, ids])).rows.map(r => r.data);
    assert.equal(live.members.length, 7);
    for (const id of ids) {
      assert.deepEqual(live.source.find(r => r.id === id), snapshot.source.find(r => r.id === id), 'Source identity/date/DD state changed');
      const original = snapshot.members.find(r => r.id === id), current = live.members.find(r => r.id === id);
      for (const key of ['id','tenant_id','email','first_name','last_name']) {
        if (key in original) assert.deepEqual(current[key], original[key], 'Member identity changed');
      }
    }
    await db.query('ROLLBACK');
  } finally { await db.end(); }
  const {getValidXeroAccessToken} = await import('../api/_lib/xero.js');
  const auth = await getValidXeroAccessToken(tenant);
  assert.equal(auth.tenantId, '3d57dce6-2205-462f-abf6-9c7cbf00be23');
  let requests = 0;
  const get = async path => {
    assert.ok(++requests <= 100, 'Request budget exceeded');
    await new Promise(r => setTimeout(r, 2100));
    const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
      method:'GET', redirect:'error', signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${auth.accessToken}`, 'xero-tenant-id':auth.tenantId, Accept:'application/json'},
    });
    assert.equal(response.status, 200, 'Provider evidence incomplete');
    if (response.headers.has('x-daylimit-remaining')) assert.ok(Number(response.headers.get('x-daylimit-remaining')) >= 500);
    return response.json();
  };
  const providers = [];
  for (const row of rows) {
    const old = oldProviders.find(p => p.memberId === row.memberId);
    const contacts = [], invoices = [], payments = [];
    for (const c of old.contacts) {
      const contact = (await get(`Contacts/${c.ContactID}`)).Contacts[0];
      for (const key of ['ContactID','AccountNumber','EmailAddress']) assert.deepEqual(contact[key], c[key], 'Provider identity changed');
      contacts.push(contact);
      // Read all contact invoices, including newer invoices; never trust only the old latest-paid ID.
      let complete = false;
      for (let page = 1; page <= 10; page++) {
        const batch = (await get(`Invoices?ContactIDs=${encodeURIComponent(c.ContactID)}&page=${page}`)).Invoices;
        assert.ok(Array.isArray(batch));
        invoices.push(...batch);
        if (batch.length < 100) { complete = true; break; }
      }
      assert.ok(complete, 'Invoice paging incomplete');
    }
    const prior = old.membershipInvoices.find(i => i.InvoiceID === old.latestPaidInvoiceId);
    const invoice = (await get(`Invoices/${prior.InvoiceID}`)).Invoices[0];
    assert.equal(invoice.InvoiceNumber, row.invoice);
    assert.ok(contacts.some(c => c.ContactID === invoice.Contact.ContactID));
    for (const p of invoice.Payments || []) {
      const payment = (await get(`Payments/${p.PaymentID}`)).Payments[0];
      assert.equal(payment.Invoice.InvoiceID, invoice.InvoiceID);
      payments.push(payment);
    }
    const source = live.source.find(r => r.id === row.memberId);
    const legacy = String(source.preferences.ym_web_site_member_id || '').trim();
    const owner = contacts.find(c => c.ContactID === invoice.Contact.ContactID);
    const accountConflict = !!owner.AccountNumber && owner.AccountNumber.trim() !== legacy;
    const emailMatch = owner.EmailAddress?.trim().toLowerCase() === row.email.trim().toLowerCase();
    const cashSettled = invoice.Status === 'PAID' && invoice.AmountDue === 0 &&
      invoice.AmountPaid === invoice.Total && !(invoice.AmountCredited || 0) && !(invoice.CreditNotes || []).length &&
      payments.length > 0 && payments.every(p => p.Status === 'AUTHORISED' && p.Amount > 0) &&
      Math.abs(payments.reduce((n,p) => n + p.Amount,0) - invoice.Total) < 0.001;
    providers.push({memberId:row.memberId, contacts, invoices, invoice, payments,
      identity:{legacy, accountConflict, emailMatch, duplicateContacts:contacts.length > 1},
      cashSettled});
  }
  fs.mkdirSync(out, {recursive:true,mode:0o700});
  const at = new Date().toISOString();
  const proposal = rows.map(row => {
    const p = providers.find(p => p.memberId === row.memberId);
    return {...row, verifiedPaid:p.cashSettled && !p.identity.accountConflict && p.identity.emailMatch,
      identity:p.identity, cashSettled:p.cashSettled, creditAmount:p.invoice.AmountCredited || 0,
      currentHistoryCount:live.histories.filter(h => h.member_id === row.memberId).length,
      proposedStart:null, proposedEnd:row.retainedExpiry,
      authority:'AWAITING RECORD-SPECIFIC APPROVAL. Unknown commencement retained. No renewal, provider write, billing consent or report override.',
    };
  });
  fs.writeFileSync(`${out}/evidence.json`, JSON.stringify({at,proposalHash:hash(bytes),live,providers,requests},null,2), {flag:'wx',mode:0o600});
  fs.writeFileSync(`${out}/proposal.json`, JSON.stringify({at,rows:proposal,membershipWrites:0,financialWrites:0},null,2), {flag:'wx',mode:0o600});
  console.log(JSON.stringify({at,requests,membershipWrites:0,financialWrites:0,rows:proposal.map(p => ({
    name:p.name,expiry:p.proposedEnd,cashSettled:p.cashSettled,identity:p.identity,credit:p.creditAmount,history:p.currentHistoryCount,
  }))},null,2));
}
main().catch(e => {
  // Do not print provider objects, tokens or connection strings from exceptions.
  console.error(JSON.stringify({stopped:true,code:e.code || e.name,
    reason:e.code === 'ERR_ASSERTION' ? e.message.split('\n')[0] : 'Read-only evidence refresh failed'}));
  process.exitCode = 1;
});
