// Six exact approvals from the retained-seven review. Adam is intentionally excluded.
// Provider calls are GET-only; the sole possible credential write is normal OAuth refresh.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {connectDestination} from './lib/member-index-destination.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {TENANT,sha,assertRecord} from './bnms-approved-72-core.mjs';
import {APPROVAL,approvalHash,buildHistoricalRecord} from './bnms-retained-seven-core.mjs';
import {projectNmcReport} from '../api/_lib/nmcMembershipReport.js';
import {MEMBERSHIP_RECOGNITION_TABLES} from '../api/_lib/alphaMembershipRecognition.js';

const root = 'generated-artifacts/bnms-retained-seven';
const original = 'generated-artifacts/bnms-nmc-25-evidence';
const read = path => JSON.parse(fs.readFileSync(path));
const save = (name,value) => fs.writeFileSync(`${root}/${name}.json`,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
function invoiceProjection(i) {
  return {id:i.InvoiceID, contact:i.Contact.ContactID, number:i.InvoiceNumber, date:i.DateString,
    status:i.Status, type:i.Type, currency:i.CurrencyCode,total:i.Total,tax:i.TotalTax,paid:i.AmountPaid,
    due:i.AmountDue, credited:i.AmountCredited || 0, credits:i.CreditNotes || [],
    lines:i.LineItems.map(l => Object.fromEntries(['LineItemID','Description','Quantity','UnitAmount',
      'TaxType','TaxAmount','LineAmount','AccountCode','AccountID'].map(k => [k,l[k] ?? null])))};
}
async function main() {
  const mode = process.argv[2];
  assert.ok(process.argv.length === 3 && ['verify','dry-run','apply','replay'].includes(mode));
  const proposalBytes = fs.readFileSync(`${original}/proposal.json`);
  assert.equal(sha(proposalBytes),'4863739b20eab5685be3cf03fe67238d795aff5bd029c4c133739d52bf4b7827');
  const evidence = read(`${root}/evidence.json`), evidenceHash = sha(fs.readFileSync(`${root}/evidence.json`));
  assert.equal(evidenceHash,'49c289c839f52024010e06ca52a2aaf66f7b3a9f403b6c044f03d1163878ab5a','Reviewed evidence changed');
  assert.equal(evidence.proposalHash,sha(proposalBytes));
  const cohort = JSON.parse(proposalBytes).rows.filter(r => r.category === 'Retain expiry: resolve historical membership evidence');
  assert.equal(cohort.length,7);
  const rows = cohort.filter(r => Object.hasOwn(APPROVAL,r.memberId));
  assert.equal(rows.length,6);
  assert.ok(!Object.hasOwn(APPROVAL,'1be724c5-febf-563c-adbf-a8986ad46c79'));
  const sources = read(`${original}/sources.json`).rows;
  for (const row of cohort) for (const match of sources.find(s => s.memberId === row.memberId).matches) {
    assert.equal(sha(fs.readFileSync(match.file)),match.fileSha256,'Source file changed');
    assert.equal(match.expiry,row.retainedExpiry);
    assert.equal(match.identityConflict,false);
  }
  destinationTarget(process.env);
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
  // This module transitively initializes the app database client: bind DEST first.
  const {SOURCE_SQL,canonicalHash} = await import('./bnms-non-dd-apply.mjs');
  if (mode === 'verify') {
    // The completed GET-only audit is already a full verification. Reuse it only
    // within the same 30-minute evidence window; never refresh its timestamp.
    if (Date.now()-Date.parse(evidence.at) < 30*60000) {
      for (const row of rows) {
        const provider = evidence.providers.find(p => p.memberId === row.memberId);
        assert.ok(provider && provider.contacts.length && provider.invoices.length);
        buildHistoricalRecord(row,evidence.live.source.find(s => s.id === row.memberId),provider);
      }
      save(`verified-${Date.now()}`,{at:evidence.at,approvalHash,evidenceHash,requests:0,
        evidenceSource:'completed_read_only_audit',providerWrites:0});
      console.log(JSON.stringify({mode,members:6,requests:0,evidenceAt:evidence.at,providerWrites:0}));
      return;
    }
    const {getValidXeroAccessToken} = await import('../api/_lib/xero.js');
    const auth = await getValidXeroAccessToken(TENANT);
    assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
    let requests = 0;
    const get = async path => {
      assert.ok(++requests <= 60);
      await new Promise(r => setTimeout(r,2100));
      const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{method:'GET',redirect:'error',
        headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
        signal:AbortSignal.timeout(30000)});
      assert.equal(response.status,200,'Provider refresh incomplete');
      if (response.headers.has('x-daylimit-remaining')) assert.ok(Number(response.headers.get('x-daylimit-remaining')) >= 500);
      return response.json();
    };
    for (const row of rows) {
      const old = evidence.providers.find(p => p.memberId === row.memberId);
      const invoices = [];
      for (const c of old.contacts) {
        const live = (await get(`Contacts/${c.ContactID}`)).Contacts[0];
        for (const key of ['ContactID','AccountNumber','EmailAddress']) assert.deepEqual(live[key],c[key],'Contact changed');
        let complete = false;
        for (let page=1;page<=10;page++) {
          const batch = (await get(`Invoices?ContactIDs=${encodeURIComponent(c.ContactID)}&page=${page}`)).Invoices;
          assert.ok(Array.isArray(batch));
          invoices.push(...batch);
          if (batch.length < 100) {complete=true;break;}
        }
        assert.ok(complete,'Incomplete provider paging');
      }
      const sorted = list => list.map(invoiceProjection).sort((a,b) => a.id.localeCompare(b.id));
      assert.equal(canonicalHash(sorted(invoices)),canonicalHash(sorted(old.invoices)),'Invoice history changed');
      const invoice = (await get(`Invoices/${old.invoice.InvoiceID}`)).Invoices[0];
      assert.deepEqual(invoiceProjection(invoice),invoiceProjection(old.invoice),'Settlement or credits changed');
      assert.deepEqual((invoice.Payments || []).map(p => p.PaymentID).sort(),old.payments.map(p => p.PaymentID).sort());
      for (const p of old.payments) {
        const live = (await get(`Payments/${p.PaymentID}`)).Payments[0];
        for (const key of ['PaymentID','Date','Amount','Status']) assert.deepEqual(live[key],p[key],'Payment changed');
        assert.equal(live.Invoice.InvoiceID,invoice.InvoiceID);
      }
    }
    save(`verified-${Date.now()}`,{at:new Date().toISOString(),approvalHash,evidenceHash,requests,providerWrites:0});
    console.log(JSON.stringify({mode,members:6,requests,providerWrites:0})); return;
  }
  const files = fs.readdirSync(root).filter(f => /^verified-\d+\.json$/.test(f)).sort();
  assert.ok(files.length,'Run verify first');
  const verified = read(`${root}/${files.at(-1)}`);
  assert.equal(verified.approvalHash,approvalHash); assert.equal(verified.evidenceHash,evidenceHash);
  assert.ok(Date.now()-Date.parse(verified.at) < 30*60000,'Provider verification older than 30 minutes');
  const records = rows.map(row => buildHistoricalRecord(row,evidence.live.source.find(s => s.id === row.memberId),
    evidence.providers.find(p => p.memberId === row.memberId)));
  const ids = new Set(records.map(r => r.id));
  const protectedTables = ['member','member_preference_value','preference_field','membership_tier_config',
    'membership_billing_agreements','membership_payment_plans','gocardless_payments','gocardless_customers',
    'gocardless_mandate_discovery_row','bnms_dd_alpha_adoption','bnms_dd_beta_adoption',
    'bnms_dd_pilot_import','bnms_dd_historical_payment','membership_expiry_policy_assignment',
    'historical_member_invoice','organization','role',...MEMBERSHIP_RECOGNITION_TABLES];
  const db = await connectDestination();
  try {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    await db.query(`LOCK TABLE member_membership_history,${protectedTables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    assert.equal((await db.query('SELECT slug FROM tenant WHERE id=$1',[TENANT])).rows[0]?.slug,'bnms');
    const table = async t => (await db.query(`SELECT to_jsonb(r) data FROM ${t} r WHERE ${
      t === 'member_preference_value' ? 'member_id IN (SELECT id FROM member WHERE tenant_id=$1)' : 'tenant_id=$1'
    } ORDER BY to_jsonb(r)::text`,[TENANT])).rows.map(r => r.data);
    const protectedSnapshot = async () => {
      const state = {};
      for (const t of protectedTables) state[t] = canonicalHash(await table(t));
      // Also protect all other tenants' history against unexpected trigger effects.
      state.otherHistory = (await db.query(`SELECT md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY id),'')) hash
        FROM member_membership_history r WHERE tenant_id IS DISTINCT FROM $1`,[TENANT])).rows[0].hash;
      return state;
    };
    const protectedBefore = await protectedSnapshot();
    const before = await table('member_membership_history'), liveSources = (await db.query(SOURCE_SQL,[TENANT])).rows;
    const members = await table('member');
    for (const row of cohort) {
      const source = structuredClone(liveSources.find(s => s.id === row.memberId));
      const own = before.filter(h => h.member_id === row.memberId);
      assert.equal(own.length,mode === 'replay' && Object.hasOwn(APPROVAL,row.memberId) ? 1 : 0,'Unexpected history');
      if (own.length) {
        assert.ok(ids.has(own[0].id)); source.history_count--;
        // The entitlement-only history must preserve the pre-existing DD hold.
        assertRecord(own[0],records.find(r => r.member_id === row.memberId));
      }
      assert.deepEqual(source,evidence.live.source.find(s => s.id === row.memberId),'Identity, expiry or DD evidence changed');
      assert.deepEqual(members.find(m => m.id === row.memberId),evidence.live.members.find(m => m.id === row.memberId),'Member changed');
    }
    for (const record of records.filter(r => r.accounting_invoice_id)) {
      assert.ok(!before.some(h => h.accounting_invoice_id === record.accounting_invoice_id && h.id !== record.id),'Invoice already linked');
    }
    const scopeHash = canonicalHash({records,sources:cohort.map(r => evidence.live.source.find(s => s.id === r.memberId)),
      members:members.filter(m => cohort.some(r => r.memberId === m.id)),before:before.filter(h => cohort.some(r => r.memberId === h.member_id))});
    if (mode === 'apply') {
      const rehearsals = fs.readdirSync(root).filter(f => /^dry-run-\d+\.json$/.test(f)).sort();
      assert.ok(rehearsals.length,'Rollback rehearsal required');
      assert.equal(read(`${root}/${rehearsals.at(-1)}`).scopeHash,scopeHash,'Scope changed since rollback rehearsal');
    }
    const input = {members,fields:await table('preference_field'),preferences:await table('member_preference_value'),
      organizations:await table('organization'),roles:await table('role'),agreements:await table('membership_billing_agreements'),
      recognitions:(await Promise.all(MEMBERSHIP_RECOGNITION_TABLES.map(table))).flat(),reportDate:'2026-10-14'};
    const reportBefore = projectNmcReport({...input,history:before});
    // Durable exclusive-create before journal precedes the first mutation, including in rehearsal.
    save(`before-${mode}-${Date.now()}`,{at:new Date().toISOString(),approvalHash,evidenceHash,scopeHash,records,
      protectedBefore,histories:before,members:members.filter(m => cohort.some(r => r.memberId === m.id)),reportBefore});
    if (mode !== 'replay') for (const record of records) {
      const keys = Object.keys(record);
      await db.query(`INSERT INTO member_membership_history (${keys.join(',')}) VALUES (${keys.map((_,i) => `$${i+1}`).join(',')})`,keys.map(k => record[k]));
    }
    const after = await table('member_membership_history');
    for (const record of records) assertRecord(after.find(h => h.id === record.id),record);
    assert.deepEqual(after.filter(h => !ids.has(h.id)),before.filter(h => !ids.has(h.id)),'Unapproved history changed');
    assert.equal(after.length-before.length,mode === 'replay' ? 0 : 6);
    assert.deepEqual(await protectedSnapshot(),protectedBefore,'Protected data changed');
    const reportAfter = projectNmcReport({...input,history:after});
    for (const record of records) assert.equal(projectNmcReport({...input,members:members.filter(m => m.id === record.member_id),history:after}).sheets[0].count,1);
    const otherMembers = members.filter(m => !Object.hasOwn(APPROVAL,m.id));
    assert.deepEqual(projectNmcReport({...input,members:otherMembers,history:after}),
      projectNmcReport({...input,members:otherMembers,history:before}),'Other report eligibility changed');
    assert.equal(reportAfter.sheets[0].count-reportBefore.sheets[0].count,mode === 'replay' ? 0 : 6);
    await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    if (mode === 'apply') for (const record of records) {
      assertRecord((await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE tenant_id=$1 AND id=$2',[TENANT,record.id])).rows[0]?.data,record);
    }
    const receipt = {at:new Date().toISOString(),mode,approvalHash,evidenceHash,scopeHash,committed:mode === 'apply',
      inserted:mode === 'apply' ? 6 : 0,rehearsed:mode === 'dry-run' ? 6 : 0,
      replayed:mode === 'replay' ? 6 : 0,providerWrites:0,billingChanges:0,protectedDataUnchanged:true,
      reportDate:input.reportDate,printBefore:reportBefore.sheets[0].count,printAfter:reportAfter.sheets[0].count};
    save(`${mode}-${Date.now()}`,receipt);
    console.log(JSON.stringify(receipt));
  } catch(e) {await db.query('ROLLBACK').catch(() => {});throw e;} finally {await db.end();}
}
main().catch(e => {
  console.error(JSON.stringify({stopped:true,code:e.code || e.name,
    reason:['ERR_ASSERTION','42703'].includes(e.code) ? e.message.split('\n')[0] : 'Repair stopped',
    location:e.stack?.split('\n').find(l => l.includes('repair-bnms-retained-seven.mjs:'))?.trim()}));
  process.exitCode = 1;
});
