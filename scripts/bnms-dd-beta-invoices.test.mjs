import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { invoiceManifest, assertHistoricalInvoicesComplete, TENANT_ID, XERO_TENANT_ID, BATCH_HASH, hash, importInvoiceLinks, applyInvoiceSchema, sqlHash } from './bnms-dd-beta-invoices.mjs';
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
  const e={tenantId:TENANT_ID,xeroTenantId:XERO_TENANT_ID,rows:[],invoices:[],contacts:[],provider:[]};
  for(let m=0;m<10;m++){
    const email=`test-${m}@example.invalid`,mandateId=`MD${m}`,customerId=`CU${m}`,contactId=uid(m+1000);
    const owner={mandate:{id:mandateId,links:{customer:customerId,creditor:'CR0000B50W1Y2R'}},customer:{id:customerId,email},payments:[]};
    e.provider.push(owner);e.contacts.push({ContactID:contactId,EmailAddress:email,ContactStatus:'ACTIVE'});
    for(let n=0;n<(m===0?23:22);n++){
      const k=e.rows.length+1,p={id:`PM${k}`,status:'paid_out',links:{mandate:mandateId,creditor:'CR0000B50W1Y2R'},
        amount:1304,amount_refunded:0,currency:'GBP',charge_date:'2026-09-08',metadata:{'Invoice number':`INV-${k}`}};
      owner.payments.push(p);
      e.rows.push({id:uid(k),member_id:uid(m+500),tenant_id:TENANT_ID,email,mandate_id:mandateId,
        customer_id:customerId,provider_payment_id:p.id,amount_minor:1304,currency:'GBP',charge_date:p.charge_date,evidence:structuredClone(p)});
      e.invoices.push({InvoiceID:uid(k+2000),InvoiceNumber:`INV-${k}`,Contact:{ContactID:contactId},Type:'ACCREC',
        Status:'PAID',CurrencyCode:'GBP',Total:13.04,AmountPaid:13.04,AmountDue:0,AmountCredited:0,
        CreditNotes:[],Prepayments:[],Overpayments:[],DateString:'2026-09-01',LineItems:[{AccountCode:'200'}],
        Payments:[{PaymentID:uid(k+3000),Reference:p.id,Amount:13.04}]});
    }
  }
  return e;
}
test('all 221 invoice links reconcile; duplicate number without provider payment is not an ambiguous match',()=>{
  const e=fixture();
  e.invoices.push({...e.invoices[0],InvoiceID:uid(9999),Payments:[]});
  const m=invoiceManifest(e);
  assert.equal(m.links.length,221);assert.equal(m.historicalInvoiceCoverage,'complete');
  assertHistoricalInvoicesComplete(e.rows,m.links);
});
for(const [name,mutate] of [
  ['missing invoice',e=>e.invoices.pop()],
  ['ambiguous exact payment',e=>e.invoices.push({...e.invoices[0],InvoiceID:uid(9999)})],
  ['wrong contact',e=>e.contacts[0].EmailAddress='other@example.invalid'],
  ['wrong member',e=>e.rows[0].tenant_id=uid(999)],
  ['wrong amount',e=>e.invoices[0].Total=14],
  ['refund',e=>e.provider[0].payments[0].amount_refunded=1],
  ['provider drift',e=>e.provider[0].payments[0].status='charged_back'],
  ['wrong month',e=>e.invoices[0].DateString='2026-08-01'],
  ['credit note',e=>e.invoices[0].CreditNotes=[{}]],
  ['payment reference',e=>e.invoices[0].Payments[0].Reference='PM_other'],
  ['wrong mandate',e=>e.provider[0].mandate.links.customer='CU_other'],
  ['duplicate history',e=>e.rows[0]=e.rows[1]],
  ['missing member',e=>e.rows.pop()],
  ['missing payment amount',e=>delete e.invoices[0].Payments[0].Amount],
]) test(`fails closed: ${name}`,()=>{const e=fixture();mutate(e);assert.throws(()=>invoiceManifest(e));});
test('alpha completion gate rejects provider-only, partial, cross-member and duplicate links',()=>{
  const e=fixture(),m=invoiceManifest(e);
  assert.throws(()=>assertHistoricalInvoicesComplete(e.rows,[]),/incomplete/);
  assert.throws(()=>assertHistoricalInvoicesComplete(e.rows,m.links.slice(1)),/incomplete/);
  m.links[0].member_id=uid(999);
  assert.throws(()=>assertHistoricalInvoicesComplete(e.rows,m.links),/incomplete/);
});
test('apply refuses wrong review hash or unvalidated manifest before SQL',async()=>{
  const e=fixture(),m=invoiceManifest(e),c={query(){throw Error('SQL must not execute');}};
  await assert.rejects(importInvoiceLinks(c,m,{apply:true,reviewSha256:'wrong',evidence:e}),/reviewed/);
  await assert.rejects(importInvoiceLinks(c,m,{apply:true,reviewSha256:hash(m)}),/Validated/);
});
test('isolated PostgreSQL: real migration, ownership guards, atomic rollback, replay and unchanged holds',{timeout:60000},async()=>{
  const root=await mkdtemp(`${tmpdir()}/bnms-invoice-test-`),data=`${root}/data`;
  let started=false,c;
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);};
  try {
    run('initdb',['-D',data,'--no-locale','--encoding=UTF8','--auth=trust','-U','postgres']);
    run('pg_ctl',['-D',data,'-l',`${root}/postgres.log`,'-o',`-k ${root} -h '' -p 5497`,'-w','start']);started=true;
    c=new pg.Client({host:root,port:5497,user:'postgres',database:'postgres'});await c.connect();
    await c.query(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text);
      CREATE TABLE bnms_dd_beta_batch(id uuid PRIMARY KEY,evidence_sha256 text);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,collection_stopped_at timestamptz,metadata jsonb,dynamic_next_collection_date date,status text);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,status text,metadata jsonb);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,xero_invoice_id uuid,accounting_invoice_id uuid,status text);
      CREATE TABLE gocardless_collection_reservations(id uuid PRIMARY KEY,plan_id uuid);
      CREATE TABLE bnms_dd_beta_adoption(id uuid PRIMARY KEY,batch_id uuid,member_id uuid,mandate_id text,customer_id text,plan_id uuid,agreement_id uuid,history_id uuid);
      CREATE TABLE bnms_dd_beta_provider_history(id uuid PRIMARY KEY,adoption_id uuid,tenant_id uuid,member_id uuid,
        provider_payment_id text,charge_date date,amount_minor integer,currency text,evidence jsonb);
      CREATE TABLE bnms_dd_historical_payment(id uuid PRIMARY KEY,tenant_id uuid,xero_invoice_id uuid);
      CREATE FUNCTION bnms_dd_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;`);
    const e=fixture(),manifest=invoiceManifest(e),digest=hash(manifest),batch=uid(9000);
    await c.query('INSERT INTO bnms_dd_beta_batch VALUES($1,$2)',[batch,BATCH_HASH]);
    for(let n=0;n<10;n++){
      const r=e.rows.find(r=>r.member_id===uid(n+500)),adoption=uid(n+600),plan=uid(n+700),agreement=uid(n+800),history=uid(n+900);
      await c.query('INSERT INTO member VALUES($1,$2,$3)',[r.member_id,TENANT_ID,r.email]);
      await c.query(`INSERT INTO membership_payment_plans VALUES($1,'2026-10-01','{"bnms_release_required":true,"collection_mode":"dynamic"}','2026-10-01','active')`,[plan]);
      await c.query(`INSERT INTO membership_billing_agreements VALUES($1,'active','{"pricing_policy":"dynamic"}')`,[agreement]);
      await c.query("INSERT INTO member_membership_history VALUES($1,$2,NULL,NULL,'pending')",[history,TENANT_ID]);
      await c.query('INSERT INTO bnms_dd_beta_adoption VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[adoption,batch,r.member_id,r.mandate_id,r.customer_id,plan,agreement,history]);
      for(const h of e.rows.filter(h=>h.member_id===r.member_id)) await c.query(
        'INSERT INTO bnms_dd_beta_provider_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [h.id,adoption,TENANT_ID,h.member_id,h.provider_payment_id,h.charge_date,h.amount_minor,h.currency,h.evidence]);
    }
    const sql=await readFile(new URL('../supabase/migrations/20261109_bnms_dd_beta_invoice_links.sql',import.meta.url),'utf8'),schemaSha256=sqlHash(sql);
    const opts={apply:true,reviewSha256:digest,evidence:e,schemaSha256};
    assert.equal((await importInvoiceLinks(c,manifest,{evidence:e})).migrationRequired,true);
    const broken=sql+"\nDO $$ BEGIN RAISE EXCEPTION 'injected schema failure'; END $$;";
    await assert.rejects(applyInvoiceSchema(c,broken,sqlHash(broken)),/injected schema failure/);
    assert.equal((await c.query("SELECT to_regclass('bnms_dd_beta_invoice_link') AS t")).rows[0].t,null);
    await c.query('CREATE TABLE bnms_dd_beta_invoice_link(id uuid)');
    await assert.rejects(applyInvoiceSchema(c,sql,schemaSha256),/schema/);
    await c.query('DROP TABLE bnms_dd_beta_invoice_link');
    await applyInvoiceSchema(c,sql,schemaSha256);
    assert.equal((await applyInvoiceSchema(c,sql,schemaSha256)).writes,0);
    await assert.rejects(applyInvoiceSchema(c,sql+' ',sqlHash(sql+' ')),/hash\/catalog/);
    const insert=async(l)=>{
      const keys=Object.keys(l);
      await c.query(`INSERT INTO bnms_dd_beta_invoice_link(${keys.join(',')},manifest_sha256)
        VALUES(${keys.map((_,n)=>`$${n+1}`).join(',')},$${keys.length+1})`,[...Object.values(l),digest]);
    };
    for(const change of [{member_id:uid(501)},{tenant_id:uid(999)},{provider_payment_id:'PM-other'},
      {xero_invoice_id:uid(999)},{xero_contact_id:uid(999)},{xero_payment_id:uid(999)}]){
      await assert.rejects(insert({...manifest.links[0],...change}),/ownership|check constraint/);
    }
    await c.query('ALTER TABLE bnms_dd_beta_invoice_link DISABLE TRIGGER beta_invoice_owner');
    await assert.rejects(applyInvoiceSchema(c,sql,schemaSha256),/hash\/catalog/);
    await c.query('ALTER TABLE bnms_dd_beta_invoice_link ENABLE TRIGGER beta_invoice_owner');
    const before=await c.query('SELECT * FROM membership_payment_plans ORDER BY id');
    // Fail midway through the real insert loop, exercising transaction rollback.
    let inserted=0;
    const failing={query:async(text,values)=>{
      if(text.startsWith('INSERT INTO bnms_dd_beta_invoice_link')&&++inserted===100) throw Error('injected data failure');
      return c.query(text,values);
    }};
    await assert.rejects(importInvoiceLinks(failing,manifest,opts),/injected data failure/);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM bnms_dd_beta_invoice_link')).rows[0].n,0);
    assert.equal((await importInvoiceLinks(c,manifest,opts)).writes,221);
    assert.equal((await importInvoiceLinks(c,manifest,opts)).mode,'replay');
    assert.deepEqual((await c.query('SELECT * FROM membership_payment_plans ORDER BY id')).rows,before.rows);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM gocardless_collection_reservations')).rows[0].n,0);
    await assert.rejects(c.query("UPDATE bnms_dd_beta_invoice_link SET xero_invoice_number='changed'"),/immutable/);
    await assert.rejects(c.query('DELETE FROM bnms_dd_beta_invoice_link'),/immutable/);
    await c.query('SET ROLE authenticated');
    await assert.rejects(c.query('SELECT * FROM bnms_dd_beta_invoice_link'),/permission denied/);
    await c.query('RESET ROLE');await c.query('SET ROLE service_role');
    await assert.rejects(c.query('DELETE FROM bnms_dd_beta_invoice_link'),/permission denied/);
    await c.query('RESET ROLE');
  }finally{
    await c?.end();if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});