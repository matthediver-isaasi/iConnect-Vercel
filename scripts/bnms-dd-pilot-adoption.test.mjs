import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { adoptionManifest,adoptPilot,buildPilotSnapshot,ACCOUNTING } from './bnms-dd-pilot-adoption.mjs';
import { parseAdoptionArgs } from './run-bnms-dd-pilot-adoption.mjs';
import { MEMBER_ID,TENANT_ID,MANDATE_ID,CUSTOMER_ID } from './bnms-dd-pilot.mjs';
import { STRUCTURE_ID,fingerprint } from './bnms-dd-pilot-history.mjs';
import { collectDynamicPlan } from '../api/_lib/gocardlessDynamicCollections.js';
import { processGocardlessEvent } from '../api/_lib/gocardlessWebhookProcessor.js';
import { releasePilot } from './bnms-dd-pilot-release.mjs';
const FIELD='87f120ff-92e6-4d52-944b-9ba9d7b1fac0';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
  const config={id:STRUCTURE_ID,tenant_id:TENANT_ID,is_active:true,structure_scope_type:'member',
    structure_field_id:FIELD,structure_match_value:'Full with NMC',pricing_model:'flat',currency:'GBP',
    dd_monthly_amount:13,flat_cost:156,start_mode:'immediate',billing_period:'annual',dd_instalment_count:12,
    dd_enabled:true,dd_auto_renew:true,dd_invoicing_mode:'per_instalment',dd_activation_rule:'first_payment',
    effective_from:'2026-09-01',effective_to:null,dd_grace_days:7,dd_terms_version:'v1',
    monthly_post_grace_collection_policy:'stop_collecting'};
  return {config,member:{id:MEMBER_ID,tenant_id:TENANT_ID},classes:[{field_id:FIELD,value:'Full with NMC'}],
    scopeConfigCount:1,price:{config_id:STRUCTURE_ID,monthly_amount_minor:1300,currency:'GBP'},
    mandate:{id:MANDATE_ID,status:'active',next_possible_charge_date:'2026-09-24',links:{customer:CUSTOMER_ID,creditor:'CR0000B50W1Y2R'}},
    customer:{id:CUSTOMER_ID},subscriptions:[],payments:[],futureInvoices:[],today:'2026-09-19'};
}
test('pilot explicit consent is dynamic/continue; period is management not join date, no shared override',()=>{
  const e=fixture(),before=structuredClone(e.config),m=adoptionManifest(e);
  assert.deepEqual(e.config,before);
  assert.deepEqual(m.dd.collection_policy,{version:1,end_policy:'continue',pricing_policy:'dynamic'});
  assert.equal(m.dd.commitment.term_start_date,'2026-10-01');
  assert.equal(m.dd.commitment.term_end_date,'2027-09-30');
  assert.equal(m.dd.commitment.membership_renewal_date,'2027-10-01');
  assert.equal(m.dd.commitment.commitment_snapshot.amounts.total_with_vat,null);
  assert.deepEqual(m.dd.accounting_migration,ACCOUNTING);
  assert.equal(m.dd.first_collection_rule,'nominated_day');assert.equal(m.dd.collection_day,1);
  assert.equal(m.approval.originalCommencementUnknown,true);
  assert.equal(m.collectionReleaseRequired,true);
});
test('identity, effective scope, amount, future duplicates and lead-time fail closed',()=>{
  for(const mutate of [
    e=>e.member.id=uuid(1),e=>e.member.tenant_id=uuid(1),e=>e.member.membership_paused=true,
    e=>e.config.dd_monthly_amount=14,e=>e.config.effective_to='2026-09-30',
    e=>e.config.effective_from='2026-10-02',e=>e.scopeConfigCount=2,
    e=>e.classes.push(e.classes[0]),e=>e.mandate.links.customer='other',
    e=>e.mandate.next_possible_charge_date='2026-10-02',e=>e.today='2026-10-02',
    e=>e.subscriptions.push({id:'SB1'}),e=>e.payments.push({charge_date:'2026-10-01',status:'paid_out',links:{mandate:MANDATE_ID}}),
    e=>e.futureInvoices.push({id:uuid(2)}),e=>e.price.monthly_amount_minor=1400,
  ]){const e=fixture();mutate(e);assert.throws(()=>adoptionManifest(e));}
  for(const a of [['--apply'],['--release'],['--member',MEMBER_ID],['--out','./report.json']])
    assert.throws(()=>parseAdoptionArgs(a));
});
test('held dynamic plan refuses provider/accounting effects even if webhook transitions status to active',async()=>{
  let mutations=0;
  const agreement={id:uuid(1),tenant_id:TENANT_ID,member_id:MEMBER_ID,status:'active',metadata:{dd:buildPilotSnapshot(fixture().config)}};
  const db={from(table){assert.equal(table,'membership_billing_agreements');return {
    select(){return this;},eq(){return this;},async single(){return {data:agreement};},
    insert(){mutations++;throw Error('unexpected mutation');},update(){mutations++;throw Error('unexpected mutation');},
  };},rpc(){mutations++;throw Error('unexpected RPC');}};
  const gc={getMandate(){throw Error('provider should not be contacted');},createPayment(){mutations++;},createSubscription(){mutations++;}};
  await assert.rejects(collectDynamicPlan({id:uuid(2),tenant_id:TENANT_ID,billing_agreement_id:agreement.id,
    status:'active',collection_stopped_at:'2026-09-19T00:00:00Z',metadata:{collection_mode:'dynamic'}},{db,gc}),/blocked/);
  assert.equal(mutations,0);
});
test('nine historical payment webhooks cannot collect, activate, or repost accounting through adopted mandate',async()=>{
  let writes=0;
  const agreement={id:uuid(20),tenant_id:TENANT_ID,member_id:MEMBER_ID,gocardless_mandate_id:MANDATE_ID,
    status:'payment_setup_required',metadata:{dd:buildPilotSnapshot(fixture().config)}};
  const db={from(table){return {select(){return this;},eq(){return this;},order(){return this;},limit(){return this;},
    async maybeSingle(){return {data:table==='membership_billing_agreements'?agreement:null,error:null};},
    insert(){writes++;throw Error('unexpected insert');},update(){writes++;throw Error('unexpected update');},
    upsert(){
      // The already-applied historical migration rejects this mirror write
      // before any canonical row or accounting effect can be created.
      assert.equal(table,'gocardless_payments');
      return {error:{message:'Historical-only BNMS payment cannot enter mutable ledger'}};
    }};},rpc(){writes++;throw Error('unexpected RPC');}};
  for(let n=1;n<=9;n++){
    const gc={getPayment:async()=>({id:`PM-${n}`,amount:1304,currency:'GBP',status:'paid_out',
      charge_date:`2026-${String(n).padStart(2,'0')}-08`,links:{mandate:MANDATE_ID}}),
      createPayment(){writes++;},createSubscription(){writes++;}};
    const deps={db,gc,postToAccounting:async()=>{writes++;},sendEmail:async()=>{writes++;}};
    const event={id:`EV-${n}`,resource_type:'payments',action:'paid_out',links:{payment:`PM-${n}`,mandate:MANDATE_ID}};
    await assert.rejects(processGocardlessEvent(event,deps),/Historical-only/);
    await assert.rejects(processGocardlessEvent({...event,action:'confirmed'},deps),/recovery metadata/);
  }
  assert.equal(writes,0);
});
test('isolated PostgreSQL atomic held adoption, rollback/resume, concurrency and immutable audit', {timeout:60000},async()=>{
  const root=await mkdtemp(`${tmpdir()}/bnms-adoption-test-`),data=`${root}/data`;
  let started=false,client,other;
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);};
  const connect=async()=>{const c=new pg.Client({host:root,port:5491,user:'postgres',database:'postgres'});await c.connect();return c;};
  try{
    run('initdb',['-D',data,'--no-locale','--encoding=UTF8','--auth=trust','-U','postgres']);
    run('pg_ctl',['-D',data,'-l',`${root}/postgres.log`,'-o',`-k ${root} -h '' -p 5491`,'-w','start']);started=true;client=await connect();
    const e=fixture();
    await client.query(`CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE membership_tier_config(${Object.entries(e.config).map(([k,v])=>`${k} ${k==='id'?'uuid PRIMARY KEY':k.endsWith('_id')?'uuid':typeof v==='boolean'?'boolean':typeof v==='number'?'numeric':'text'}`).join(',')});
      CREATE TABLE preference_field(id uuid PRIMARY KEY,tenant_id uuid,name text,entity_scope text,is_active boolean);
      CREATE TABLE member_preference_value(id uuid PRIMARY KEY,member_id uuid,field_id uuid,value text);
      CREATE TABLE gocardless_collection_reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,plan_id uuid,
        collection_number integer,due_date date,requested_charge_date date,amount_minor integer,currency text);
      INSERT INTO member VALUES('${MEMBER_ID}','${TENANT_ID}');
      INSERT INTO preference_field VALUES('${FIELD}','${TENANT_ID}','member_class','member',true);
      INSERT INTO member_preference_value VALUES('${uuid(900)}','${MEMBER_ID}','${FIELD}','Full with NMC');`);
    await client.query(`INSERT INTO membership_tier_config(${Object.keys(e.config).join(',')}) VALUES(${Object.keys(e.config).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(e.config));
    const foundation=await readFile(new URL('../supabase/migrations/20260726_gocardless_foundation.sql',import.meta.url),'utf8');
    // Only base table DDL, avoiding unrelated policy/permission assumptions.
    await client.query(foundation.slice(foundation.indexOf('CREATE TABLE IF NOT EXISTS gocardless_customers'),foundation.indexOf('CREATE TABLE IF NOT EXISTS payment_webhook_events')));
    const terms=`term_start_date date,term_end_date date,membership_renewal_date date,term_duration_months integer,
      term_anchor_date date,term_key text,previous_term_id uuid,commitment_snapshot jsonb`;
    await client.query(`ALTER TABLE membership_billing_agreements ADD COLUMN provider text,${terms.split(',').map(s=>' ADD COLUMN '+s).join(',')};
      ALTER TABLE membership_payment_plans ADD COLUMN provider text,ADD COLUMN dynamic_next_collection_date date,ADD COLUMN collection_stopped_at timestamptz,ADD COLUMN instalments_total integer;
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,
        billing_agreement_id uuid REFERENCES membership_billing_agreements(id),membership_year text,config_id uuid,tier_label text,currency text,
        annual_cost numeric,final_cost numeric,vat_amount numeric,total_with_vat numeric,billing_period text,payment_method text,
        status text,payment_status text,notes text,xero_invoice_id text,accounting_invoice_id text,${terms});`);
    await client.query(`CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,term_key text,quote jsonb);`);
    const rolling=await readFile(new URL('../supabase/migrations/20260920_rolling_membership_commitments.sql',import.meta.url),'utf8');
    const functions=rolling.slice(rolling.indexOf('CREATE OR REPLACE FUNCTION rolling_commitment_fields'));
    await client.query(functions.slice(0,functions.indexOf('\nDO $$')));
    const dated=await readFile(new URL('../supabase/migrations/20261108_direct_debit_dated_commitments.sql',import.meta.url),'utf8');
    await client.query(dated.slice(dated.indexOf('DO $migration$'),dated.indexOf('END $migration$;')+'END $migration$;'.length));
    for(const t of ['membership_billing_agreements','member_membership_history'])
      await client.query(`CREATE TRIGGER rolling_commitment_guard BEFORE INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION enforce_rolling_membership_commitment()`);
    await client.query(await readFile(new URL('../supabase/migrations/20261108_bnms_dd_pilot_history.sql',import.meta.url),'utf8'));
    await client.query('BEGIN');
    const parent=(await client.query(`INSERT INTO bnms_dd_pilot_import(tenant_id,member_id,structure_id,mandate_id,customer_id,evidence_sha256,evidence)
      VALUES($1,$2,$3,$4,$5,'c016597c54b30549dd0e50c5994d8d4b1d0578d5cb31437dbec2b1bb9de09c52','{}') RETURNING id`,
      [TENANT_ID,MEMBER_ID,STRUCTURE_ID,MANDATE_ID,CUSTOMER_ID])).rows[0];
    for(let n=1;n<=9;n++)await client.query(`INSERT INTO bnms_dd_historical_payment(import_id,tenant_id,member_id,period,charge_date,
      amount_minor,currency,provider_payment_id,provider_status,xero_invoice_id,xero_invoice_number,xero_payment_id,evidence)
      VALUES($1,$2,$3,$4,$4,1304,'GBP',$5,'paid_out',$6,$5,$7,'{}')`,
      [parent.id,TENANT_ID,MEMBER_ID,`2026-${String(n).padStart(2,'0')}-01`,`PM-${n}`,uuid(n),uuid(n+100)]);
    await client.query('COMMIT');
    assert.equal((await adoptPilot(client,e)).migrationRequired,true);
    const sql=await readFile(new URL('../supabase/migrations/20261110_bnms_dd_pilot_adoption.sql',import.meta.url),'utf8');
    await client.query(sql);await client.query(sql);
    const opts={apply:true,verifiedDestination:true,reviewSha256:fingerprint(adoptionManifest(e))};
    await assert.rejects(adoptPilot(client,e,{...opts,reviewSha256:'bad'}),/reviewed/);
    await client.query(`CREATE FUNCTION fail_adoption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE TRIGGER fail_adoption BEFORE INSERT ON bnms_dd_pilot_adoption FOR EACH ROW EXECUTE FUNCTION fail_adoption();`);
    await assert.rejects(adoptPilot(client,e,opts),/injected/);
    for(const t of ['membership_billing_agreements','membership_payment_plans','member_membership_history','gocardless_customers','gocardless_mandates'])
      assert.equal((await client.query(`SELECT count(*)::integer AS n FROM ${t}`)).rows[0].n,0);
    await client.query('DROP TRIGGER fail_adoption ON bnms_dd_pilot_adoption');
    other=await connect();
    const results=await Promise.allSettled([adoptPilot(client,e,opts),adoptPilot(other,e,opts)]);
    assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.mode==='adopted_collection_held').length,1);
    for(const r of results.filter(r=>r.status==='rejected'))assert.ok(['40001','23505'].includes(r.reason.code),r.reason.message);
    const replay=await adoptPilot(client,e,opts);assert.equal(replay.writes,0);
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM bnms_dd_pilot_adoption')).rows[0].n,1);
    const plan=(await client.query('SELECT * FROM membership_payment_plans')).rows[0];
    assert.ok(plan.collection_stopped_at);assert.equal(plan.status,'payment_setup_required');assert.equal(plan.gocardless_subscription_id,null);
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM bnms_dd_historical_payment')).rows[0].n,9);
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM gocardless_payments')).rows[0].n,0);
    await assert.rejects(client.query("UPDATE bnms_dd_pilot_adoption SET evidence='{}'"),/immutable/);
    const configAfter=(await client.query('SELECT to_jsonb(c) AS data FROM membership_tier_config c')).rows[0].data;
    assert.equal(fingerprint(configAfter),fingerprint(e.config));
    const proof={version:1,deploymentId:'dpl_test',projectId:'prj_test',commit:'a'.repeat(40),sourceHashes:{test:'b'.repeat(64)}};
    const accounts={bank:{AccountID:ACCOUNTING.bank_account_id,Type:'BANK',Status:'ACTIVE',CurrencyCode:'GBP'},
      revenue:{AccountID:'8f87b705-a870-4c5e-b46a-74a5a4de73ce',Code:'200',Status:'ACTIVE',Type:'REVENUE'}};
    const releaseInput={evidence:e,proof,accounts};
    await assert.rejects(releasePilot(client,{...releaseInput,accounts:{...accounts,bank:{...accounts.bank,Status:'ARCHIVED'}}}),/bank\/revenue/);
    const releaseDry=await releasePilot(client,releaseInput);
    assert.equal(releaseDry.migrationRequired,true);
    const releaseSql=await readFile(new URL('../supabase/migrations/20261111_bnms_dd_pilot_release.sql',import.meta.url),'utf8');
    await client.query(releaseSql);await client.query(releaseSql);
    const reserve=(date)=>client.query(`INSERT INTO gocardless_collection_reservations(tenant_id,plan_id,collection_number,due_date,requested_charge_date,amount_minor,currency)
      VALUES($1,$2,1,'2026-10-01',$3,1300,'GBP')`,[TENANT_ID,plan.id,date]);
    await assert.rejects(reserve('2026-10-01'),/not been explicitly released/);
    const releaseOpts={...releaseInput,apply:true,verifiedDestination:true,reviewSha256:releaseDry.hash};
    await client.query(`CREATE TRIGGER fail_release BEFORE UPDATE ON membership_payment_plans FOR EACH ROW EXECUTE FUNCTION fail_adoption()`);
    await assert.rejects(releasePilot(client,releaseOpts),/injected/);
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM bnms_dd_pilot_release')).rows[0].n,0);
    assert.ok((await client.query('SELECT collection_stopped_at FROM membership_payment_plans')).rows[0].collection_stopped_at);
    await client.query('DROP TRIGGER fail_release ON membership_payment_plans');
    const releaseResults=await Promise.allSettled([releasePilot(client,releaseOpts),releasePilot(other,releaseOpts)]);
    assert.equal(releaseResults.filter(r=>r.status==='fulfilled'&&r.value.mode==='released_to_dynamic_worker').length,1);
    for(const r of releaseResults.filter(r=>r.status==='rejected'))assert.ok(['40001','23505'].includes(r.reason.code),r.reason.message);
    const releasedReplay=await releasePilot(client,{apply:true,verifiedDestination:true,reviewSha256:releaseDry.hash});
    assert.equal(releasedReplay.writes,0);assert.equal(releasedReplay.readinessRevalidated,false);
    assert.equal((await client.query('SELECT collection_stopped_at FROM membership_payment_plans')).rows[0].collection_stopped_at,null);
    await assert.rejects(reserve('2026-10-02'),/exactly October 1/);
    await reserve('2026-10-01'); // Local reservation fixture only: no provider called.
    await assert.rejects(client.query("UPDATE bnms_dd_pilot_release SET evidence='{}'"),/immutable/);
  }finally{
    await other?.end();await client?.end();
    if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});