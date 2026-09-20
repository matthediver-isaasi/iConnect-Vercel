import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import XLSX from 'xlsx';
import { TENANT_ID, WORKBOOK_SHA256 } from './bnms-dd-pilot.mjs';
import { hash, sqlHash, XERO_TENANT_ID, assertHistoricalInvoicesComplete } from './bnms-dd-beta-invoices.mjs';
import { alphaManifest, adoptAlpha, applyAlphaSchema, verifyAlphaSchema, alphaStructureMatches } from './bnms-dd-alpha-adoption.mjs';
import { classifyPopulation, alphaProviderReader } from './bnms-dd-alpha-review.mjs';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('live structure comparison ignores only top-level audit timestamp',()=>{
  const reviewed={dd_monthly_amount:'13',is_active:true,effective_from:'2026-09-01',updated_at:'old',policy:{updated_at:'nested'}};
  assert.equal(alphaStructureMatches({...reviewed,updated_at:'new'},reviewed),true);
  for(const change of [{dd_monthly_amount:'14'},{is_active:false},{effective_from:'2026-10-01'},{policy:{updated_at:'changed'}},{new_eligibility:true}]){
    assert.equal(alphaStructureMatches({...reviewed,...change},reviewed),false);
  }
});
async function fixture(){
  const wb=XLSX.read(await readFile(new URL('../attached_assets/DD_matched_different_emails_1789802289108.xlsx',import.meta.url)),{type:'buffer'});
  const grid=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''});
  const member={id:uuid(1),tenant_id:TENANT_ID,email:'alpha-fixture@example.test',status:'active',membership_paused:false};
  const structure={id:uuid(2),tenant_id:TENANT_ID,is_active:true,dd_enabled:true,structure_scope_type:'member',
    structure_field_id:uuid(3),structure_match_value:'Full',currency:'GBP',pricing_model:'flat',start_mode:'immediate',
    dd_activation_rule:'manual',dd_invoicing_mode:'per_instalment',dd_monthly_amount:'13',flat_cost:'156',
    billing_period:'annual',dd_instalment_count:12,dd_grace_days:7,dd_terms_version:'v1',effective_from:'2026-09-01',effective_to:null};
  const mandate={id:'MDALPHA',status:'active',links:{customer:'CUALPHA',creditor:'CR0000B50W1Y2R'}};
  const customer={id:'CUALPHA',email:member.email};
  const payment={id:'PMALPHA',status:'paid_out',amount:1300,amount_refunded:0,currency:'GBP',charge_date:'2026-01-01',
    links:{mandate:mandate.id,creditor:'CR0000B50W1Y2R'},metadata:{'Invoice number':'INV-123'}};
  const invoice={InvoiceID:uuid(4),InvoiceNumber:'INV-123',Type:'ACCREC',Status:'PAID',CurrencyCode:'GBP',
    Total:13,AmountPaid:13,AmountDue:0,AmountCredited:0,DateString:'2026-01-01T00:00:00',
    Contact:{ContactID:uuid(5)},Payments:[{PaymentID:uuid(6),Reference:payment.id,Amount:13}],
    CreditNotes:[],Prepayments:[],Overpayments:[],LineItems:[{AccountCode:'200'}]};
  const source={version:1,tenantId:TENANT_ID,xeroTenantId:XERO_TENANT_ID,workbookSha256:WORKBOOK_SHA256,
    completeAccountDiscovery:true,observedAt:'2026-09-20T00:00:00Z',grid,
    provider:{mandates:[mandate],customers:[customer],payments:[payment],subscriptions:[]},
    snapshot:{members:[member],structures:[structure],preferences:[{member_id:member.id,field_id:uuid(3),name:'member_class',value:'Full'}],
      discovery:[],beta:Array.from({length:10},(_,n)=>({member_id:uuid(100+n),mandate_id:`MDBETA${n}`,customer_id:`CUBETA${n}`})),
      agreements:[],plans:[],history:[]}};
  const accounting={invoices:[invoice],contacts:[{ContactID:uuid(5),ContactStatus:'ACTIVE',EmailAddress:member.email}]};
  const entitlements=[{memberId:member.id,verified:true,sourceSha256:'a'.repeat(64),sourceDescription:'Disposable test authoritative entitlement',
    start:'2025-10-01',end:'2026-09-30'}];
  return {source,accounting,entitlements};
}
test('alpha Jan 1 inclusive, mandatory full invoice identities and no invented dynamic totals',async()=>{
  const f=await fixture(),m=alphaManifest(f.source,f.accounting,f);
  assert.equal(m.members.length,1);
  const a=m.members[0];
  assert.equal(a.history[0].charge_date,'2026-01-01');
  assert.equal(a.dd.activation_rule,'first_payment');
  assert.equal(a.dd.commitment.term_start_date,'2026-10-01');
  assert.equal(a.dd.commitment.term_end_date,'2027-09-30');
  assert.equal(a.dd.plan_total,null);assert.equal(a.dd.final_cost,null);
  assert.equal(a.dd.commitment.commitment_snapshot.amounts.total_with_vat,null);
  assert.deepEqual(a.dd.collection_policy,{version:1,end_policy:'continue',pricing_policy:'dynamic'});
  assert.throws(()=>assertHistoricalInvoicesComplete(a.history,[]),/coverage incomplete/);
  const missing=alphaManifest(f.source,f.accounting);
  assert.equal(missing.members.length,1);
  assert.deepEqual(missing.members[0].currentPriorEntitlement,{verified:false,start:null,end:null,unchanged:true});
  assert.equal(missing.approval.scope,'explicit_user_approved_future_held_term_only');
  assert.equal(missing.approval.priorEntitlementUnchanged,true);
  const altered=structuredClone(missing);altered.approval.start='2026-01-01';
  await assert.rejects(adoptAlpha({query:()=>assert.fail('SQL must not run')},altered,
    {source:f.source,accounting:f.accounting}),/Reconstructed reviewed evidence/);
  for(const date of ['2025-12-31','2026-10-01']){
    const g=await fixture();g.source.provider.payments[0].charge_date=date;
    assert.equal(alphaManifest(g.source,g.accounting,g).members.length,0);
  }
  f.accounting.invoices.push({...f.accounting.invoices[0],InvoiceID:uuid(20)});
  assert.equal(alphaManifest(f.source,f.accounting,f).members.length,0);
});
test('complete discovery fails closed and pilot/beta and duplicate mandate identities excluded',async()=>{
  const f=await fixture();
  const i=f.source.snapshot.beta[0];i.member_id=uuid(1);
  assert.equal(classifyPopulation(f.source).filter(e=>e.disposition==='excluded_pilot_beta').length,1);
  assert.equal(alphaManifest(f.source,f.accounting,f).members.length,0);
  assert.throws(()=>alphaProviderReader({source:'platform',tenantId:TENANT_ID,accessToken:'secret',environment:'live'}));
  f.source.completeAccountDiscovery=false;
  assert.throws(()=>alphaManifest(f.source,f.accounting,f),/Complete pinned/);
});
test('disposable SQL alpha atomic member, replay, invoice holds, tenant security and schema tamper',{timeout:60000},async()=>{
  const root=await mkdtemp(`${tmpdir()}/bnms-alpha-test-`),data=`${root}/data`;
  let c,started=false;
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);};
  try{
    run('initdb',['-D',data,'--no-locale','--encoding=UTF8','--auth=trust','-U','postgres']);
    run('pg_ctl',['-D',data,'-l',`${root}/postgres.log`,'-o',`-k ${root} -h '' -p 5498`,'-w','start']);started=true;
    c=new pg.Client({host:root,port:5498,user:'postgres',database:'postgres'});await c.connect();
    const f=await fixture();
    const secondMember={...f.source.snapshot.members[0],id:uuid(21),email:'second-alpha-fixture@example.test'};
    f.source.snapshot.members.push(secondMember);
    f.source.snapshot.preferences.push({...f.source.snapshot.preferences[0],member_id:uuid(21)});
    f.source.provider.customers.push({id:'CUALPHA2',email:secondMember.email});
    f.source.provider.mandates.push({id:'MDALPHA2',status:'active',links:{customer:'CUALPHA2',creditor:'CR0000B50W1Y2R'}});
    f.source.provider.payments.push({...f.source.provider.payments[0],id:'PMALPHA2',
      links:{mandate:'MDALPHA2',creditor:'CR0000B50W1Y2R'},metadata:{'Invoice number':'INV-124'}});
    f.accounting.invoices.push({...f.accounting.invoices[0],InvoiceID:uuid(24),InvoiceNumber:'INV-124',
      Contact:{ContactID:uuid(25)},Payments:[{PaymentID:uuid(26),Reference:'PMALPHA2',Amount:13}]});
    f.accounting.contacts.push({ContactID:uuid(25),ContactStatus:'ACTIVE',EmailAddress:secondMember.email});
    f.entitlements.push({...f.entitlements[0],memberId:uuid(21)});
    const m=alphaManifest(f.source,f.accounting,f),config=f.source.snapshot.structures[0];
    assert.equal(m.members.length,2);
    await c.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text,status text,membership_paused boolean);
      CREATE TABLE membership_tier_config(${Object.entries(config).map(([k,v])=>`${k} ${k==='id'?'uuid PRIMARY KEY':k.endsWith('_id')?'uuid':typeof v==='boolean'?'boolean':typeof v==='number'?'integer':'text'}`).join(',')});
      CREATE TABLE preference_field(id uuid PRIMARY KEY,tenant_id uuid,name text,entity_scope text,is_active boolean);
      CREATE TABLE member_preference_value(id uuid PRIMARY KEY,member_id uuid,field_id uuid,value text);
      CREATE TABLE gocardless_collection_reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),plan_id uuid,gocardless_payment_id text);
      CREATE TABLE gocardless_mandate_discovery_row(id uuid,environment text,gocardless_mandate_id text,gocardless_customer_id text,matched_member_id uuid,tenant_id uuid);
      CREATE TABLE bnms_dd_historical_payment(id uuid PRIMARY KEY,provider_payment_id text,xero_invoice_id uuid);
      CREATE TABLE bnms_dd_beta_adoption(id uuid PRIMARY KEY,member_id uuid,mandate_id text,customer_id text);
      CREATE TABLE bnms_dd_beta_provider_history(id uuid PRIMARY KEY,provider_payment_id text);
      CREATE TABLE bnms_dd_beta_invoice_link(history_id uuid PRIMARY KEY,xero_invoice_id uuid,xero_payment_id uuid);
      CREATE FUNCTION bnms_dd_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;`);
    await c.query(`INSERT INTO membership_tier_config(${Object.keys(config).join(',')}) VALUES(${Object.keys(config).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(config));
    await c.query("INSERT INTO preference_field VALUES($1,$2,'member_class','member',true)",[uuid(3),TENANT_ID]);
    await c.query("INSERT INTO member VALUES($1,$2,$3,'active',false)",[uuid(1),TENANT_ID,'alpha-fixture@example.test']);
    await c.query("INSERT INTO member_preference_value VALUES($1,$2,$3,'Full')",[uuid(9),uuid(1),uuid(3)]);
    await c.query("INSERT INTO member VALUES($1,$2,$3,'active',false)",[uuid(21),TENANT_ID,secondMember.email]);
    await c.query("INSERT INTO member_preference_value VALUES($1,$2,$3,'Full')",[uuid(29),uuid(21),uuid(3)]);
    const foundation=await readFile(new URL('../supabase/migrations/20260726_gocardless_foundation.sql',import.meta.url),'utf8');
    await c.query(foundation.slice(foundation.indexOf('CREATE TABLE IF NOT EXISTS gocardless_customers'),foundation.indexOf('CREATE TABLE IF NOT EXISTS payment_webhook_events')));
    const terms='term_start_date date,term_end_date date,membership_renewal_date date,term_duration_months integer,term_anchor_date date,term_key text,previous_term_id uuid,commitment_snapshot jsonb';
    await c.query(`ALTER TABLE membership_billing_agreements ADD COLUMN provider text,${terms.split(',').map(s=>' ADD COLUMN '+s).join(',')};
      ALTER TABLE membership_payment_plans ADD COLUMN provider text,ADD COLUMN dynamic_next_collection_date date,ADD COLUMN collection_stopped_at timestamptz,ADD COLUMN instalments_total integer;
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,
        billing_agreement_id uuid REFERENCES membership_billing_agreements(id),membership_year text,config_id uuid,tier_label text,currency text,
        annual_cost numeric,final_cost numeric,vat_amount numeric,total_with_vat numeric,billing_period text,payment_method text,
        status text,payment_status text,notes text,xero_invoice_id uuid,accounting_invoice_id uuid,${terms});`);
    const sql=await readFile(new URL('../supabase/migrations/20261113_bnms_dd_alpha_held.sql',import.meta.url),'utf8'),sha=sqlHash(sql);
    const opts={...f,apply:true,reviewSha256:hash(m),verifiedDestination:true,schemaSha256:sha,verifyLiveMember:async()=>{}};
    const dry=await adoptAlpha(c,m,{...opts,apply:false});assert.equal(dry.writes,0);
    await applyAlphaSchema(c,sql,sha,{verifiedDestination:true});
    assert.equal((await applyAlphaSchema(c,sql,sha,{verifiedDestination:true})).writes,0);
    await c.query(`CREATE FUNCTION alpha_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE TRIGGER fail BEFORE INSERT ON bnms_dd_alpha_invoice_link FOR EACH ROW EXECUTE FUNCTION alpha_test_fail()`);
    // An unreviewed trigger itself is a catalog change; gate catches it before writes.
    await assert.rejects(adoptAlpha(c,m,opts),/schema drift/);
    await c.query('DROP TRIGGER fail ON bnms_dd_alpha_invoice_link');
    await verifyAlphaSchema(c,sha);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM membership_payment_plans')).rows[0].n,0);
    // Inject a connector error only after canonical + provider-history inserts.
    // Real PostgreSQL rolls back the entire member; no phantom partial adoption.
    const broken={query:async(sql,args)=>{
      if(sql.startsWith('INSERT INTO bnms_dd_alpha_invoice_link'))throw Error('injected invoice connector failure');
      return c.query(sql,args);
    }};
    await assert.rejects(adoptAlpha(broken,m,opts),/injected invoice connector/);
    for(const table of ['membership_payment_plans','membership_billing_agreements','member_membership_history',
      'bnms_dd_alpha_adoption','bnms_dd_alpha_provider_history','bnms_dd_alpha_invoice_link'])
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
    // A later-member failure preserves the earlier member's complete atomic
    // import; the same pinned manifest resumes without rewriting that member.
    const laterBroken={query:async(sql,args)=>{
      if(sql.startsWith('INSERT INTO bnms_dd_alpha_invoice_link')&&args[2]===uuid(21))
        throw Error('later member failure');
      return c.query(sql,args);
    }};
    await assert.rejects(adoptAlpha(laterBroken,m,{...opts,batchSize:1}),/later member failure/);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM bnms_dd_alpha_adoption')).rows[0].n,1);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM bnms_dd_alpha_invoice_link')).rows[0].n,1);
    const applied=await adoptAlpha(c,m,{...opts,batchSize:1});assert.equal(applied.writes,8);
    assert.equal(applied.results[0].mode,'replay');
    assert.equal((await adoptAlpha(c,m,opts)).writes,0);
    for(const sql of [
      'UPDATE membership_payment_plans SET collection_stopped_at=NULL',
      "UPDATE membership_billing_agreements SET status='active'",
      "UPDATE member_membership_history SET payment_status='paid'",
      'DELETE FROM bnms_dd_alpha_invoice_link',
      'DELETE FROM membership_payment_plans',
    ])await assert.rejects(c.query(sql),/immutable|cannot activate/);
    await assert.rejects(c.query('INSERT INTO gocardless_collection_reservations(plan_id) VALUES($1)',[m.members[0].ids.plan]),/release not approved/);
    await assert.rejects(c.query(`INSERT INTO gocardless_payments(tenant_id,gocardless_payment_id,amount_minor,currency,status,environment)
      VALUES($1,'PMALPHA',1300,'GBP','paid_out','live')`,[TENANT_ID]),/cannot activate/);
    const a=(await c.query('SELECT * FROM member_membership_history')).rows[0];
    assert.equal(a.final_cost,null);assert.equal(a.total_with_vat,null);assert.equal(a.payment_status,'unpaid');
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM member_membership_history
      WHERE term_start_date<>'2026-10-01' OR term_end_date<>'2027-09-30' OR status<>'pending_payment_setup'`)).rows[0].n,0);
    const unchanged=(await c.query('SELECT * FROM member ORDER BY id')).rows;
    assert.equal(hash(unchanged),hash([...f.source.snapshot.members].sort((a,b)=>a.id.localeCompare(b.id))));
    assert.deepEqual(m.members.map(x=>x.currentPriorEntitlement),
      m.members.map(()=>({verified:false,start:null,end:null,unchanged:true})));
    for(const role of ['anon','authenticated','service_role']){
      await c.query(`SET ROLE ${role}`);
      await assert.rejects(c.query('DELETE FROM bnms_dd_alpha_provider_history'),/permission denied/);
      if(role!=='service_role')await assert.rejects(c.query('SELECT * FROM bnms_dd_alpha_provider_history'),/permission denied/);
      await c.query('RESET ROLE');
    }
    await c.query('ALTER TABLE bnms_dd_alpha_adoption DISABLE TRIGGER alpha_complete');
    await assert.rejects(verifyAlphaSchema(c,sha),/schema drift/);
  }finally{
    if(c)await c.end();
    if(started)spawnSync('pg_ctl',['-D',data,'-m','immediate','-w','stop'],{encoding:'utf8'});
    await rm(root,{recursive:true,force:true});
  }
});