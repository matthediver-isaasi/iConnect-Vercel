// One owner-approved historical recovery. Default is read-only review.
// Financial writes use the existing fenced accounting queue and stable key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const apply = process.argv[2] === '--apply';
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && apply), 'Use no arguments or --apply');
destinationTarget(process.env);
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const company = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
const requestId = 'dd582ae7-c8a5-4ab5-bb89-c4810385bd71';
const sourceId = '825ee01b-0ddb-496e-b8ca-ef46de4703cd';
const organizationId = 'e5737658-2145-480c-a9b3-46135b90e732';
const contactId = 'e4c687a1-fe28-4d5c-8d6b-3e74420882de';
const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { getValidXeroAccessToken, createXeroMembershipInvoice } = await import('../api/_lib/xero.js');
const { getAccountingQueueAdapter } = await import('../api/_lib/accountingQueueIntegration.js');
const { processAccountingRequest } = await import('../api/_lib/accountingRequestQueue.js');
const { assertFormInvoiceSource } = await import('../api/_lib/formInvoiceOrder.js');
const { verifyFrozenOrganizationContact, normalizeOrganizationName } = await import('../api/_lib/formInvoiceOrganization.js');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const one = async query => { const r = await query; if (r.error) throw Object.assign(new Error('Database operation failed'), {code:r.error.code}); assert.ok(r.data); return r.data; };
const load = () => one(db.from('accounting_request_queue').select('*').eq('id',requestId).eq('tenant_id',tenant).single());
const before = await load();
assert.equal(before.source_id,sourceId);
assert.equal(before.source_type,'form_invoice_order');
assert.equal(before.provider,'xero');
assert.equal(before.company_id,company);
assert.equal(before.connection_id,'ae863481-7552-454d-886a-d3fb54f9cbc0');
assert.equal(before.snapshot.linkage.formId,'56f11cfb-2ffa-4665-8294-a92943ca6700');
assert.equal(before.snapshot.invoice.totalMinor,475440);
assert.equal(before.snapshot.invoice.invoiceDate,'2026-11-11');
assert.equal(before.snapshot.invoice.dueDate,'2026-12-11');
assert.equal(before.snapshot.invoice.args.organizationName,"Addenbrooke's Hospital");
assert.equal(before.snapshot.invoice.args.reference,'Spring Meeting Exhibitor Booking');
assert.equal(before.snapshot.payment,null);
assert.deepEqual(before.snapshot.lines,[{taxCode:'OUTPUT2',netMinor:396200,quantity:1,taxMinor:79240,
  grossMinor:475440,accountCode:'210',description:'Bronze Sponsor - Stand 4'}]);
const sourceBefore = await assertFormInvoiceSource({db,row:before});
const snapshotHash = hash(before.snapshot);
const submissionBefore = await one(db.from('form_submission').select('submission_data,payment_meta,payment_status,payment_amount,payment_currency')
  .eq('id',sourceId).eq('tenant_id',tenant).single());
const organization = await one(db.from('organization').select('id,name').eq('id',organizationId).eq('tenant_id',tenant).single());
assert.equal(normalizeOrganizationName(organization.name),normalizeOrganizationName("Addenbrooke's Hospital"));
const customer = {version:1,organizationId,organizationName:organization.name,contactId,companyId:company,
  connectionId:before.connection_id,matchPolicy:'owner_approved_historical_binding'};
const auth = await getValidXeroAccessToken(tenant);
assert.equal(auth.tenantId,company);
const read = async path => {
  const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`,{headers:{
    Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':company,Accept:'application/json'},
    signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Xero read HTTP ${response.status}`);
  return response.json();
};
const currentContact = (await read(`Contacts/${contactId}`)).Contacts?.[0];
await verifyFrozenOrganizationContact(customer,company,read);
assert.equal(normalizeOrganizationName(currentContact.Name),normalizeOrganizationName(organization.name));
// Issuing an invoice legitimately changes contact Balances and may change its
// update timestamp. Compare identity/address fields, not the full provider row.
const contactIdentity = contact => Object.fromEntries([
  'ContactID','Name','EmailAddress','ContactStatus','Addresses','Phones','ContactPersons',
  'TaxNumber','AccountNumber','BankAccountDetails',
].map(key=>[key,contact?.[key] ?? null]));
const contactHash = hash(contactIdentity(currentContact));
const printResult = async row => {
  assert.ok(row.invoice_result?.id,'No durable invoice evidence');
  const invoice = (await read(`Invoices/${row.invoice_result.id}`)).Invoices?.[0];
  assert.equal(invoice?.Contact?.ContactID,contactId);
  assert.equal(invoice.Reference,'TBC');
  assert.equal(invoice.Status,'AUTHORISED');
  assert.equal(Math.round(invoice.Total*100),475440);
  assert.equal(Math.round(invoice.AmountDue*100),475440);
  assert.equal(Math.round(invoice.AmountPaid*100),0);
  assert.equal(invoice.DateString?.slice(0,10),'2026-11-11');
  assert.equal(invoice.DueDateString?.slice(0,10),'2026-12-11');
  const source=await assertFormInvoiceSource({db,row});
  assert.equal(source.payment_meta?.invoice_result?.id,invoice.InvoiceID);
  assert.equal(row.state,'complete');
  assert.equal(row.link_status,'done');
  assert.equal(hash(row.snapshot),snapshotHash);
  console.log(JSON.stringify({applied:apply,state:row.state,invoice:invoice.InvoiceNumber,invoiceId:invoice.InvoiceID,
    reference:invoice.Reference,total:invoice.Total,amountDue:invoice.AmountDue,currency:invoice.CurrencyCode,
    linked:true,originalSnapshotPreserved:true}));
};
if(before.state==='complete'){
  await printResult(before);
}else{
  assert.equal(before.state,'review');
  assert.equal(before.preparation_status,'pending');
  assert.equal(before.invoice_status,'pending');
  assert.equal(before.link_status,'pending');
  assert.equal(before.resolved_snapshot,null);
  assert.equal(before.invoice_result,null);
  assert.equal(before.lease_until,null);
  assert.equal(sourceBefore.payment_meta.invoice_result,undefined);
  // Stop even for void/deleted matching invoices: their history needs review.
  const duplicates=await read('Invoices?'+new URLSearchParams({
    where:`Type=="ACCREC"&&Contact.ContactID==Guid("${contactId}")&&Total==4754.4`,
  }));
  assert.ok(Array.isArray(duplicates.Invoices));
  assert.equal(duplicates.Invoices.length,0,'Potential matching invoice already exists; no recovery attempted');
  if(!apply){
    console.log(JSON.stringify({ready:true,requestId,sourceId,total:4754.4,currency:'GBP',reference:'TBC',
      contact:"Addenbrooke's Hospital",duplicates:0,financialWrites:0,originalSnapshotHash:snapshotHash}));
  }else{
    let invoiceWrites=0;
    const guardedFetch=async(url,init={})=>{
      const parsed=new URL(url);
      const method=(init.method||'GET').toUpperCase();
      assert.equal(parsed.origin,'https://api.xero.com');
      if(method!=='GET'){
        assert.equal(method,'POST');
        assert.equal(parsed.pathname,'/api.xro/2.0/Invoices');
        const payload=JSON.parse(init.body);
        const invoice=payload.Invoices?.[0];
        assert.equal(payload.Invoices.length,1);
        assert.equal(invoice.Contact.ContactID,contactId);
        assert.equal(invoice.Reference,'TBC');
        assert.equal(invoice.Date,'2026-11-11');
        assert.equal(invoice.DueDate,'2026-12-11');
        assert.equal(++invoiceWrites,1,'Only one financial write is allowed per run');
      }
      return fetch(url,init);
    };
    const adapters=async(row,controls)=>{
      assert.equal(row.id,requestId);
      const adapter=await getAccountingQueueAdapter(row,controls,{db,fetchImpl:guardedFetch,preparation:{
        prepare:async(args,options)=>createXeroMembershipInvoice({...args,reference:'TBC'},{
          ...options,findOrCreateXeroContact:async(token,providerCompany)=>{
            assert.equal(providerCompany,company);
            return verifyFrozenOrganizationContact(customer,company,async path=>{
              const r=await options.fetch(`https://api.xero.com/api.xro/2.0/${path}`,{headers:{
                Authorization:`Bearer ${token}`,'xero-tenant-id':company,Accept:'application/json'}});
              assert.ok(r.ok,'Contact verification failed');
              return r.json();
            });
          },
        }),
      }});
      const prepare=adapter.prepare;
      adapter.prepare=async candidate=>{
        const resolved=await prepare(candidate);
        resolved.organizationCustomer=customer;
        resolved.historicalRecovery={reason:'Owner-approved existing-contact binding and TBC reference',
          originalSnapshotHash:snapshotHash,originalReference:before.snapshot.invoice.args.reference};
        assert.equal(resolved.invoice.envelope.payload.Reference,'TBC');
        assert.equal(resolved.invoice.envelope.expected.fields.Reference,'TBC');
        return resolved;
      };
      adapter.createPayment=()=>{throw new Error('Payment creation forbidden');};
      return adapter;
    };
    // Reactivate only the reviewed request; normal queue claims/guards own
    // every following preparation, creation and linkage stage.
    // Queue rows deliberately deny direct service-role updates. Use the
    // approved administrative connection only for this exact reactivation;
    // never broaden service grants or bypass the immutable-authority trigger.
    const target=destinationTarget(process.env);
    const caResponse=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
    assert.ok(caResponse.ok);
    const sql=new pg.Client({connectionString:target.toString(),connectionTimeoutMillis:15000,
      ssl:{ca:await caResponse.text(),rejectUnauthorized:true,servername:target.hostname}});
    try{
      await sql.connect();
      assert.ok(sql.connection.stream.authorized);
      const reactivated=await sql.query(`UPDATE public.accounting_request_queue
        SET state='retry',next_attempt_at=now()
        WHERE id=$1 AND tenant_id=$2 AND attempts=$3 AND snapshot=$4::jsonb
        AND state='review' AND lease_until IS NULL AND invoice_result IS NULL AND resolved_snapshot IS NULL
        AND preparation_status='pending' AND invoice_status='pending' RETURNING id`,
        [requestId,tenant,before.attempts,JSON.stringify(before.snapshot)]);
      assert.equal(reactivated.rowCount,1,'Reviewed queue state changed');
    }finally{await sql.end();}
    await processAccountingRequest({db,requestId,adapters});
    const after=await load();
    if(after.state!=='complete'){
      console.log(JSON.stringify({state:after.state,preparation:after.preparation_status,invoice:after.invoice_status,
        link:after.link_status,error:after.last_error,invoiceId:after.invoice_result?.id,invoiceWrites}));
      throw new Error('Recovery did not fully complete; inspect recorded state before any retry');
    }
    const submissionAfter=await one(db.from('form_submission').select('submission_data,payment_meta,payment_status,payment_amount,payment_currency')
      .eq('id',sourceId).eq('tenant_id',tenant).single());
    assert.deepEqual(submissionAfter.submission_data,submissionBefore.submission_data);
    assert.equal(submissionAfter.payment_status,submissionBefore.payment_status);
    assert.equal(submissionAfter.payment_amount,submissionBefore.payment_amount);
    assert.equal(submissionAfter.payment_currency,submissionBefore.payment_currency);
    const expectedMeta={...submissionBefore.payment_meta,invoice_result:after.invoice_result};
    assert.deepEqual(submissionAfter.payment_meta,expectedMeta);
    assert.equal(hash(contactIdentity((await read(`Contacts/${contactId}`)).Contacts?.[0])),contactHash,'Contact identity was unexpectedly changed');
    await printResult(after);
  }
}
