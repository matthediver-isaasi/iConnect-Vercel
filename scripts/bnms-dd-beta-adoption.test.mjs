import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {betaManifest,adoptBeta} from './bnms-dd-beta-adoption.mjs';
import {parseArgs,applyBetaSchema} from './run-bnms-dd-beta-adoption.mjs';
import {applyInvoiceSchema,sqlHash} from './bnms-dd-beta-invoices.mjs';
import {TENANT_ID,digest} from './bnms-dd-pilot.mjs';
import {processGocardlessEvent} from '../api/_lib/gocardlessWebhookProcessor.js';
import {postDdInstalmentToAccounting} from '../api/_lib/gocardlessAccounting.js';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const field=uuid(100);
function fixture(){
  const structure={id:uuid(101),tenant_id:TENANT_ID,is_active:true,dd_enabled:true,structure_scope_type:'member',
    structure_field_id:field,structure_match_value:'Full',currency:'GBP',pricing_model:'flat',
    start_mode:'immediate',dd_activation_rule:'manual',dd_invoicing_mode:'per_instalment',dd_monthly_amount:'13',
    flat_cost:'156',billing_period:'annual',dd_instalment_count:12,dd_grace_days:7,dd_terms_version:'v1',
    effective_from:'2026-09-01',effective_to:null};
  return {tenantId:TENANT_ID,candidates:Array.from({length:10},(_,n)=>{
    const identity={group:n<5?'spreadsheet':'direct_match',memberId:uuid(n+1),customerId:`CU${n}`,mandateId:`MD${n}`,email:`m${n}@example.test`};
    return {identity,member:{id:identity.memberId,tenant_id:TENANT_ID},applicableStructures:[structure],
      preferences:[{name:'member_class',value:'Full'}],subscriptions:[],existing:{plans:[],agreements:[],history:[]},
      mandate:{id:identity.mandateId,status:'active',links:{customer:identity.customerId,creditor:'CR0000B50W1Y2R'}},
      payments:[{id:`PM${n}`,amount:1304,currency:'GBP',status:'paid_out',charge_date:'2026-09-08',links:{mandate:identity.mandateId}}]};
  })};
}
test('beta approval overrides activation only in snapshot and never invents entitlement or accounting',()=>{
  const f=fixture(),m=betaManifest(f);
  assert.equal(f.candidates[0].applicableStructures[0].dd_activation_rule,'manual');
  for(const r of m.members){
    assert.equal(r.dd.activation_rule,'first_payment');
    assert.deepEqual(r.dd.collection_policy,{version:1,end_policy:'continue',pricing_policy:'dynamic'});
    assert.equal(r.dd.commitment.term_start_date,'2026-10-01');
    assert.equal(r.dd.commitment.term_end_date,'2027-09-30');
    assert.equal(r.dd.commitment.commitment_snapshot.amounts.total_with_vat,null);
    assert.equal(r.dd.plan_total,null);assert.equal(r.dd.final_cost,null);assert.equal(r.dd.total_with_vat,null);
    assert.equal(r.dd.accounting_migration,undefined);
    assert.equal(r.originalCurrentEntitlement,null);assert.equal(r.legacyAutomaticCollectionDisabled,null);
  }
  for(const mutate of [f=>f.candidates.pop(),f=>f.candidates[0].payments[0].status='confirmed',
    f=>f.candidates[0].payments[0].charge_date='2026-10-01',f=>f.candidates[0].identity=f.candidates[1].identity,
    f=>f.candidates[0].payments[0].id=f.candidates[1].payments[0].id]){
    const f=fixture();mutate(f);assert.throws(()=>betaManifest(f));
  }
  assert.throws(()=>parseArgs(['--apply']));assert.throws(()=>parseArgs(['--release']));
});
test('isolated PostgreSQL beta schema, atomic held import, rollback, replay and historical guards',{timeout:60000},async()=>{
  const root=await mkdtemp(`${tmpdir()}/bnms-beta-test-`),data=`${root}/data`;
  let started=false,c;
  const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);};
  try{
    run('initdb',['-D',data,'--no-locale','--encoding=UTF8','--auth=trust','-U','postgres']);
    run('pg_ctl',['-D',data,'-l',`${root}/postgres.log`,'-o',`-k ${root} -h '' -p 5494`,'-w','start']);started=true;
    c=new pg.Client({host:root,port:5494,user:'postgres',database:'postgres'});await c.connect();
    const f=fixture(),config=f.candidates[0].applicableStructures[0],m=betaManifest(f);
    await c.query(`CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text,status text,membership_paused boolean);
      CREATE TABLE membership_tier_config(${Object.entries(config).map(([k,v])=>`${k} ${k==='id'?'uuid PRIMARY KEY':k.endsWith('_id')?'uuid':typeof v==='boolean'?'boolean':typeof v==='number'?'integer':'text'}`).join(',')});
      CREATE TABLE preference_field(id uuid PRIMARY KEY,tenant_id uuid,name text,entity_scope text,is_active boolean);
      CREATE TABLE member_preference_value(id uuid PRIMARY KEY,member_id uuid,field_id uuid,value text);
      CREATE TABLE gocardless_collection_reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),plan_id uuid,gocardless_payment_id text);
      CREATE TABLE gocardless_mandate_discovery_row(id uuid,environment text,gocardless_mandate_id text,gocardless_customer_id text,matched_member_id uuid,tenant_id uuid);
      CREATE TABLE bnms_dd_historical_payment(id uuid PRIMARY KEY,provider_payment_id text);
      CREATE FUNCTION bnms_dd_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;`);
    await c.query(`INSERT INTO membership_tier_config(${Object.keys(config).join(',')}) VALUES(${Object.keys(config).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(config));
    await c.query(`INSERT INTO preference_field VALUES($1,$2,'member_class','member',true)`,[field,TENANT_ID]);
    for(const r of m.members){
      await c.query("INSERT INTO member VALUES($1,$2,$3,'active',false)",[r.identity.memberId,TENANT_ID,r.identity.email]);
      await c.query("INSERT INTO member_preference_value VALUES($1,$2,$3,'Full')",[uuid(200+m.members.indexOf(r)),r.identity.memberId,field]);
    }
    const foundation=await readFile(new URL('../supabase/migrations/20260726_gocardless_foundation.sql',import.meta.url),'utf8');
    await c.query(foundation.slice(foundation.indexOf('CREATE TABLE IF NOT EXISTS gocardless_customers'),foundation.indexOf('CREATE TABLE IF NOT EXISTS payment_webhook_events')));
    const terms='term_start_date date,term_end_date date,membership_renewal_date date,term_duration_months integer,term_anchor_date date,term_key text,previous_term_id uuid,commitment_snapshot jsonb';
    await c.query(`ALTER TABLE membership_billing_agreements ADD COLUMN provider text,${terms.split(',').map(s=>' ADD COLUMN '+s).join(',')};
      ALTER TABLE membership_payment_plans ADD COLUMN provider text,ADD COLUMN dynamic_next_collection_date date,ADD COLUMN collection_stopped_at timestamptz,ADD COLUMN instalments_total integer;
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,
        billing_agreement_id uuid REFERENCES membership_billing_agreements(id),membership_year text,config_id uuid,tier_label text,currency text,
        annual_cost numeric,final_cost numeric,vat_amount numeric,total_with_vat numeric,billing_period text,payment_method text,
        status text,payment_status text,notes text,${terms});`);
    await c.query('CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,organization_id uuid,term_key text,quote jsonb)');
    const rolling=await readFile(new URL('../supabase/migrations/20260920_rolling_membership_commitments.sql',import.meta.url),'utf8');
    const functions=rolling.slice(rolling.indexOf('CREATE OR REPLACE FUNCTION rolling_commitment_fields'));
    await c.query(functions.slice(0,functions.indexOf('\nDO $$')));
    const dated=await readFile(new URL('../supabase/migrations/20261108_direct_debit_dated_commitments.sql',import.meta.url),'utf8');
    await c.query(dated.slice(dated.indexOf('DO $migration$'),dated.indexOf('END $migration$;')+'END $migration$;'.length));
    for(const table of ['membership_billing_agreements','member_membership_history'])
      await c.query(`CREATE TRIGGER rolling_commitment_guard BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION enforce_rolling_membership_commitment()`);
    const before=await adoptBeta(c,m);assert.equal(before.migrationRequired,true);assert.equal(before.plannedRows,71);
    const schema=await readFile(new URL('../supabase/migrations/20261112_bnms_dd_beta_held.sql',import.meta.url),'utf8');
    const brokenSchema=schema+"\nDO $$ BEGIN RAISE EXCEPTION 'schema injected'; END $$;";
    await assert.rejects(applyBetaSchema(c,brokenSchema,digest(brokenSchema)),/schema injected/);
    assert.equal((await c.query("SELECT to_regclass('bnms_dd_beta_batch') AS t")).rows[0].t,null);
    await applyBetaSchema(c,schema,digest(schema));
    assert.equal((await applyBetaSchema(c,schema,digest(schema))).writes,0);
    await assert.rejects(applyBetaSchema(c,schema+' ',digest(schema+' ')),/hash\/catalog/);
    await c.query('ALTER TABLE membership_payment_plans DISABLE TRIGGER bnms_dd_beta_plan_hold');
    await assert.rejects(applyBetaSchema(c,schema,digest(schema)),/hash\/catalog/);
    await c.query('ALTER TABLE membership_payment_plans ENABLE TRIGGER bnms_dd_beta_plan_hold');
    await c.query(`CREATE FUNCTION injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE TRIGGER fail BEFORE INSERT ON bnms_dd_beta_provider_history FOR EACH ROW EXECUTE FUNCTION injected_failure();`);
    const opts={apply:true,verifiedDestination:true,reviewSha256:before.hash};
    await assert.rejects(adoptBeta(c,m,opts),/injected/);
    assert.equal((await c.query('SELECT count(*)::integer AS n FROM membership_payment_plans')).rows[0].n,0);
    await c.query('DROP TRIGGER fail ON bnms_dd_beta_provider_history');
    const applied=await adoptBeta(c,m,opts);assert.equal(applied.writes,71);
    const replay=await adoptBeta(c,m,opts);assert.equal(replay.writes,0);
    assert.equal((await c.query('SELECT count(*)::integer AS n FROM gocardless_payments')).rows[0].n,0);
    const plan=(await c.query('SELECT * FROM membership_payment_plans LIMIT 1')).rows[0];
    await assert.rejects(c.query('UPDATE membership_payment_plans SET collection_stopped_at=NULL WHERE id=$1',[plan.id]),/release requires/);
    for(const update of ["status='active'","gocardless_subscription_id='SB-drift'","amount_minor=1",
      "dynamic_next_collection_date='2026-10-02'","metadata=jsonb_set(metadata,'{collection_mode}','\"subscription\"')",
      "environment='sandbox'","day_of_month=2"]){
      await assert.rejects(c.query(`UPDATE membership_payment_plans SET ${update} WHERE id=$1`,[plan.id]),/release requires/);
    }
    await c.query(`UPDATE membership_payment_plans SET metadata=metadata||'{"admin_note":"harmless"}'::jsonb WHERE id=$1`,[plan.id]);
    await assert.rejects(c.query("UPDATE membership_billing_agreements SET status='active'"),/immutable until reviewed release/);
    await assert.rejects(c.query("UPDATE member_membership_history SET payment_status='paid'"),/cannot activate/);
    const verified=(await c.query(`SELECT p.amount_minor,p.currency,p.start_date::text,p.dynamic_next_collection_date::text,
      a.metadata->'dd' AS dd,h.final_cost,h.total_with_vat,h.term_start_date::text,h.term_end_date::text
      FROM membership_payment_plans p JOIN membership_billing_agreements a ON a.id=p.billing_agreement_id
      JOIN member_membership_history h ON h.billing_agreement_id=a.id`)).rows;
    for(const row of verified){
      assert.equal(row.final_cost,null);assert.equal(row.total_with_vat,null);
      assert.equal(row.amount_minor,row.dd.monthly_amount_minor);assert.equal(row.currency,row.dd.currency);
      assert.equal(row.start_date,'2026-10-01');assert.equal(row.dynamic_next_collection_date,row.start_date);
      assert.equal(row.term_start_date,row.start_date);assert.equal(row.term_end_date,'2027-09-30');
    }
    await assert.rejects(c.query('INSERT INTO gocardless_collection_reservations(plan_id) VALUES($1)',[plan.id]),/held/);
    await assert.rejects(c.query(`INSERT INTO gocardless_payments(tenant_id,gocardless_payment_id,amount_minor,currency,status,environment)
      VALUES($1,'PM0',1304,'GBP','paid_out','live')`,[TENANT_ID]),/Historical beta/);
    // Exercise production dispatch, using PostgreSQL's real historical guard
    // for attempted inserts. Refund/payout lookups see the real empty mutable
    // ledger; no made-up imported canonical payment can drive side effects.
    const agreement=(await c.query('SELECT * FROM membership_billing_agreements WHERE member_id=$1',[uuid(1)])).rows[0];
    let effects=0,payoutMirrors=0;
    const db={from(table){
      const filters={};let updating=false;
      const q={select(){return q;},eq(k,v){filters[k]=v;return q;},or(){return q;},order(){return q;},limit(){return q;},
        async maybeSingle(){
          if(table==='membership_billing_agreements')return {data:agreement,error:null};
          if(table==='gocardless_payments')return {data:(await c.query('SELECT * FROM gocardless_payments WHERE gocardless_payment_id=$1',[filters.gocardless_payment_id])).rows[0]||null,error:null};
          return {data:null,error:null};
        },
        update(){assert.equal(table,'gocardless_payments');updating=true;return q;},
        then(resolve,reject){
          if(!updating)return Promise.resolve({data:[],error:null}).then(resolve,reject);
          return c.query('UPDATE gocardless_payments SET status=status WHERE gocardless_payment_id=$1 RETURNING tenant_id',[filters.gocardless_payment_id])
            .then(r=>({data:r.rows,error:null})).then(resolve,reject);
        },
        insert(){effects++;throw Error('unexpected side-effect insert');},
        async upsert(row){
          if(table==='gocardless_payouts'){payoutMirrors++;assert.equal(row.tenant_id,null);return {data:row,error:null};}
          assert.equal(table,'gocardless_payments');
          try{
            await c.query(`INSERT INTO gocardless_payments(tenant_id,gocardless_payment_id,amount_minor,currency,status,environment)
              VALUES($1,$2,1304,'GBP',$3,'live')`,[row.tenant_id,row.gocardless_payment_id,row.status]);
            effects++;return {data:row,error:null};
          }catch(e){return {data:null,error:{message:e.message}};}
        }};
      return q;
    },rpc(){effects++;throw Error('unexpected side-effect RPC');}};
    const gc={getPayment:async()=>f.candidates[0].payments[0],
      getRefund:async()=>({id:'RF-beta',links:{payment:'PM0'}}),
      getPayout:async()=>({id:'PO-beta',amount:1304,currency:'GBP',status:'paid'}),
      listPayoutItems:async()=>[{type:'payment_paid_out',amount:'1304',links:{payment:'PM0'}}],
      createPayment(){effects++;throw Error('provider write');},
      createSubscription(){effects++;throw Error('provider write');}};
    const deps={db,gc,postToAccounting:async()=>{effects++;},sendEmail:async()=>{effects++;}};
    for(const action of ['created','submitted','confirmed','paid_out','failed','cancelled','charged_back',
      'late_failure_settled','chargeback_settled','resubmission_requested']){
      await assert.rejects(processGocardlessEvent({id:`EV-${action}`,resource_type:'payments',action,
        links:{payment:'PM0',mandate:'MD0'}},deps),/Historical beta|recovery metadata/);
    }
    for(const action of ['created','paid','funds_returned','refund_settled','failed']){
      assert.equal((await processGocardlessEvent({resource_type:'refunds',action,links:{refund:'RF-beta',payment:'PM0'}},deps)).handled,false);
    }
    await processGocardlessEvent({resource_type:'payouts',action:'paid',links:{payout:'PO-beta'}},deps);
    const accounting=await postDdInstalmentToAccounting({agreement,paymentRow:{
      id:uuid(999),gocardless_payment_id:'PM0',amount_minor:1304,currency:'GBP',
    }},{db,getProvider:async()=>({name:'xero',createInvoice(){effects++;throw Error('accounting write');}})});
    assert.equal(accounting.status,'skipped');
    assert.equal(payoutMirrors,1);assert.equal(effects,0);
    assert.equal((await c.query('SELECT count(*)::integer AS n FROM gocardless_payments')).rows[0].n,0);
    await assert.rejects(c.query("UPDATE bnms_dd_beta_provider_history SET evidence='{}'"),/immutable/);
    await assert.rejects(c.query("INSERT INTO bnms_dd_beta_batch(tenant_id,evidence_sha256,evidence) VALUES($1,$2,'{}')",[TENANT_ID,'a'.repeat(64)]),/ten adoptions/);
    // Independent append-only invoice schema must not invalidate the original
    // beta-held catalog fingerprint or weaken its collection guards.
    const invoiceSql=await readFile(new URL('../supabase/migrations/20261109_bnms_dd_beta_invoice_links.sql',import.meta.url),'utf8');
    await applyInvoiceSchema(c,invoiceSql,sqlHash(invoiceSql));
    assert.equal((await applyBetaSchema(c,schema,digest(schema))).mode,'schema_replay');
  }finally{await c?.end();if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);await rm(root,{recursive:true,force:true});}
});