import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { exerciseFunnelJourney } from './eventFunnelJourney.postgres.scenarios.mjs';
import { exerciseFunnelPublication } from './eventFunnelPublication.postgres.scenarios.mjs';
import { exerciseFunnelOrders } from './eventFunnelOrders.postgres.scenarios.mjs';
import { exerciseFunnelCommit } from './eventFunnelCommit.postgres.scenarios.mjs';
import { exerciseFunnelTraining } from './eventFunnelTraining.postgres.scenarios.mjs';
import { exerciseFunnelVoucherFoundation } from './eventFunnelVoucherFoundation.postgres.scenarios.mjs';
import { exerciseFunnelVoucherOrders } from './eventFunnelVoucherOrders.postgres.scenarios.mjs';
import { exerciseFunnelGroups } from './eventFunnelGroups.postgres.scenarios.mjs';
import { exerciseFunnelMaintenance } from './eventFunnelMaintenance.postgres.scenarios.mjs';
import { exerciseFunnelDiscovery } from './eventFunnelDiscovery.postgres.scenarios.mjs';
import { startAwardsPostgrest } from '../../scripts/test-support/awards-postgrest.mjs';
import { scopeEventFunnelDiscovery } from './eventFunnelDiscovery.js';
import { exerciseFunnelActivation } from './eventFunnelActivation.postgres.scenarios.mjs';
import { exerciseFunnelPurchasePolicy } from './eventFunnelPurchasePolicy.postgres.scenarios.mjs';
import { assertStandaloneEventOffer } from './eventFunnelPurchasePolicy.js';
import { exerciseFunnelLegacyIntent } from './eventFunnelLegacyIntent.postgres.scenarios.mjs';
import { exerciseFunnelInvoicePreparation } from './eventFunnelInvoicePreparation.postgres.scenarios.mjs';
import { exerciseFunnelInvoiceDelivery } from './eventFunnelInvoiceDelivery.postgres.scenarios.mjs';
import { exerciseFunnelQuickBooks } from './eventFunnelQuickBooks.postgres.scenarios.mjs';
import { exerciseFunnelInvoiceReaders } from './eventFunnelInvoiceReaders.postgres.scenarios.mjs';
import { exerciseFunnelOwnedInvoices } from './eventFunnelOwnedInvoices.postgres.scenarios.mjs';
import { exerciseFunnelConfirmations } from './eventFunnelConfirmations.postgres.scenarios.mjs';
import { exerciseFunnelConfirmationRetention } from './eventFunnelConfirmationRetention.postgres.scenarios.mjs';
import { exerciseFunnelIntegrations } from './eventFunnelIntegrations.postgres.scenarios.mjs';
import { exerciseFunnelZoomRecovery } from './eventFunnelZoomRecovery.postgres.scenarios.mjs';
import { exerciseFunnelMailgunReceipt } from './eventFunnelMailgunReceipt.postgres.scenarios.mjs';
import { exerciseFunnelInventoryEvidence } from './eventFunnelInventoryEvidence.postgres.scenarios.mjs';
import { exerciseFunnelReversalLedger } from './eventFunnelReversalLedger.postgres.scenarios.mjs';
import { exerciseFunnelTrainingRefund } from './eventFunnelTrainingRefund.postgres.scenarios.mjs';
import { exerciseFunnelVoucherRefundPlan } from './eventFunnelVoucherRefundPlan.postgres.scenarios.mjs';
import { exerciseFunnelCancellationCommit } from './eventFunnelCancellationCommit.postgres.scenarios.mjs';
import { exerciseFunnelReversalRecovery } from './eventFunnelReversalRecovery.postgres.scenarios.mjs';
import { exerciseFunnelIssuedInvoice } from './eventFunnelIssuedInvoice.postgres.scenarios.mjs';
import { exerciseFunnelCreditStore } from './eventFunnelCreditStore.postgres.scenarios.mjs';
import { exerciseFunnelCreditProducer } from './eventFunnelCreditProducer.postgres.scenarios.mjs';
import { exerciseFunnelQuickBooksEvidence } from './eventFunnelQuickBooksEvidence.postgres.scenarios.mjs';
import { exerciseFunnelQuickBooksCredit } from './eventFunnelQuickBooksCredit.postgres.scenarios.mjs';
import { exerciseFunnelRefundOptions } from './eventFunnelRefundOptions.postgres.scenarios.mjs';
import { exerciseFunnelReversalWorker } from './eventFunnelReversalWorker.postgres.scenarios.mjs';
import { exerciseFunnelSelectedVoucherRefunds } from './eventFunnelSelectedVoucherRefunds.postgres.scenarios.mjs';
import { exerciseFunnelCancellationApproval } from './eventFunnelCancellationApproval.postgres.scenarios.mjs';
import { exerciseFunnelCancelledDelivery } from './eventFunnelCancelledDelivery.postgres.scenarios.mjs';
import { exerciseFunnelFinalGaps } from './eventFunnelFinalGaps.postgres.scenarios.mjs';
import { exerciseFunnelCreditEmails } from './eventFunnelCreditEmails.postgres.scenarios.mjs';
import { exerciseFunnelTicketRouting } from './eventFunnelTicketRouting.postgres.scenarios.mjs';
import { exerciseFunnelCollections } from './eventFunnelCollections.postgres.scenarios.mjs';
import { exerciseFunnelDiscount } from './eventFunnelDiscount.postgres.scenarios.mjs';

test('shared funnel holds serialize ordinary/commercial stock, preserve failed edits and pin uncertain payment stock', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('funnel-stock-'), clients = [];
  let started = false,gateway;
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
  const connect = async () => {
    const c = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    clients.push(c); await c.connect(); return c;
  };
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tenant = uuid(1), source = uuid(2), complex = uuid(3), tc = uuid(4), member = uuid(5), definition = uuid(6);
  const s1=uuid(10),s2=uuid(11),s3=uuid(12),allocation=uuid(20);
  const sql = name => readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
    started=true;
    const db=await connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,available_seats integer,
        is_unlimited_registration boolean,is_complex boolean DEFAULT false,pricing_config jsonb);
      CREATE TABLE complex_event(LIKE event INCLUDING ALL);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY,tenant_id uuid,complex_event_id uuid,
        available_count integer,is_unlimited_tickets boolean);
      CREATE TABLE booking(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,event_id uuid,
        ticket_class_id text,status text,created_at timestamptz DEFAULT now(),member_id uuid,organization_id uuid,
        attendee_email text,attendee_first_name text,attendee_last_name text,payment_method text,stripe_payment_intent_id text);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE sales_commercial_allocation(id uuid PRIMARY KEY,tenant_id uuid,sale_id uuid,
        event_reference_kind text,event_id uuid,ticket_type_id text);
      CREATE TABLE sales_commercial_allocation_movement(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,
        allocation_id uuid,movement_kind text,places integer);
      CREATE TABLE public_ticket_member_purchase(id uuid PRIMARY KEY,tenant_id uuid,event_id uuid,event_kind text,
        booking_ids uuid[] DEFAULT '{}',snapshot jsonb,state text DEFAULT 'prepared',
        stripe_payment_intent_id text,last_error_code text,updated_at timestamptz);
      CREATE FUNCTION normalize_public_ticket_email(text) RETURNS text LANGUAGE sql AS $$ SELECT lower(trim($1)) $$;
    `);
    const commercial=await sql('20260910_sales_commercial_allocation.sql');
    await db.query(commercial.slice(commercial.indexOf('CREATE VIEW public.sales_commercial_allocation_totals AS'),commercial.indexOf('CREATE OR REPLACE FUNCTION public.sales_capacity_state(')));
    for(const name of ['sales_capacity_state','check_oneoff_ticket_capacity','check_complex_event_ticket_capacity']) {
      const start=commercial.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      await db.query(commercial.slice(start,commercial.indexOf('END $$;',start)+7));
    }
    for(const name of ['20261005122000_public_ticket_member_booking_batch.sql','202701220001_simple_event_total_capacity.sql',
      '202701230001_event_funnel_definitions.sql','202701230002_event_funnel_sessions.sql','202701230003_event_funnel_inventory.sql']) {
      await db.query(await sql(name));
    }
    await db.query(`INSERT INTO event(id,tenant_id,capacity_mode,total_capacity,pricing_config) VALUES($1,$2,'total',2,
      '{"ticket_classes":[{"id":"A","available_count":2},{"id":"B","available_count":2},{"id":"G","available_count":3,"is_group_ticket":true,"group_size":2}]}')`,[source,tenant]);
    await db.query('INSERT INTO complex_event(id,tenant_id,available_seats) VALUES($1,$2,2)',[complex,tenant]);
    await db.query('INSERT INTO complex_event_ticket_class VALUES($1,$2,$3,2,false)',[tc,tenant,complex]);
    await db.query('INSERT INTO member VALUES($1,$2)',[member,tenant]);
    const graph={version:1,tenantId:tenant,entry:'source',reservationSeconds:900,invoiceMode:'per_event',nodes:[
      {id:'source',type:'source',event:{id:source,kind:'simple',tenantId:tenant},ticketIds:['A','G'],requires:[],accept:'addon'},
      {id:'addon',type:'addon',event:{id:source,kind:'simple',tenantId:tenant},ticketIds:['B'],requires:['source'],accept:'other',skip:'other'},
      {id:'other',type:'event',event:{id:complex,kind:'complex',tenantId:tenant},ticketIds:[tc],requires:[],accept:'checkout',skip:'checkout'},
      {id:'checkout',type:'checkout'},
    ]};
    await db.query(`SELECT event_funnel_save_definition($1,$2,'fixture',0,'Stock fixture',$3,'{"positions":{}}')`,[tenant,definition,graph]);
    const version=(await db.query(`INSERT INTO event_funnel_version(tenant_id,definition_id,definition_revision,graph,commercial_snapshot)
      VALUES($1,$2,1,$3,'{}') RETURNING id`,[tenant,definition,graph])).rows[0].id;
    for(const session of [s1,s2,s3]) await db.query(`INSERT INTO event_funnel_session(id,tenant_id,version_id,member_id,access_expires_at,retain_until)
      VALUES($1,$2,$3,$4,now()+interval '1 day',now()+interval '7 days')`,[session,tenant,version,member]);
    const line=(nodeId,ticketId,quantity=1)=>({nodeId,ticketId,quantity,priceSnapshot:{unitMinor:1000,currency:'GBP'}});
    const reserve=async(client,session,revision,lines,rereserve=false)=>(await client.query(
      'SELECT event_funnel_replace_holds($1,$2,$3,NULL,$4,$5,$6) result',[tenant,session,member,revision,JSON.stringify(lines),rereserve])).rows[0].result;
    const first=await reserve(db,s1,1,[line('source','A')]);
    const deadline=first.session.expires_at;
    assert.equal(first.holds[0].places,1);
    const resume=(await db.query('SELECT event_funnel_read_session($1,$2,$3,NULL) r',[tenant,s1,member])).rows[0].r;
    assert.equal(resume.holds.length,1);
    assert.equal(resume.holds[0].price_snapshot.unitMinor,1000);
    assert.equal(resume.session.guest_capability_hash,undefined);
    assert.equal(resume.holds[0].session_id,undefined);
    await assert.rejects(db.query('SELECT event_funnel_read_session($1,$2,$3,NULL)',[tenant,s1,uuid(99)]),{code:'PT404'});
    const a=await connect(),b=await connect();
    const race=await Promise.allSettled([
      reserve(a,s2,1,[line('source','A')]),
      b.query(`INSERT INTO booking(tenant_id,event_id,ticket_class_id,status) VALUES($1,$2,'B','confirmed') RETURNING id`,[tenant,source]),
    ]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(race.find(r=>r.status==='rejected').reason.code,'23514');
    assert.equal((await db.query('SELECT simple_event_capacity($1) c',[source])).rows[0].c.remaining,0);
    // Remove only the fixture race winner so the held source can be edited.
    await db.query('DELETE FROM booking');
    await db.query(`UPDATE event_funnel_session SET state='cancelled' WHERE id=$1`,[s2]);
    await assert.rejects(reserve(db,s1,2,[line('source','A'),line('addon','B',2)]),{code:'23514'});
    const original=(await db.query('SELECT event_funnel_read_session($1,$2,$3,NULL) r',[tenant,s1,member])).rows[0].r.session;
    assert.equal(original.revision,2);
    assert.equal(original.expires_at,deadline);
    assert.equal((await db.query('SELECT count(*) FROM event_funnel_hold WHERE session_id=$1',[s1])).rows[0].count,'1');
    const added=await reserve(db,s1,2,[line('source','A'),line('other',tc)]);
    assert.equal(added.session.expires_at,deadline);
    assert.equal(added.holds.length,2);
    const publicCounts=(await db.query('SELECT event_funnel_inventory_projection($1,\'complex\',$2) r',[tenant,[complex]])).rows[0].r;
    assert.deepEqual(publicCounts,[{event_id:complex,ticket_id:tc,places:1}]);
    assert.deepEqual((await db.query('SELECT event_funnel_inventory_projection($1,\'complex\',$2) r',[uuid(99),[complex]])).rows[0].r,[]);
    await assert.rejects(db.query('UPDATE complex_event SET available_seats=0 WHERE id=$1',[complex]),{code:'23514'});
    await db.query('UPDATE complex_event SET available_seats=1 WHERE id=$1',[complex]);
    await db.query('INSERT INTO complex_event_booking(tenant_id,event_id,ticket_class_id,status) VALUES($1,$2,$3,\'confirmed\')',[tenant,complex,tc]);
    await assert.rejects(db.query('INSERT INTO complex_event_booking(tenant_id,event_id,ticket_class_id,status) VALUES($1,$2,$3,\'confirmed\')',[tenant,complex,tc]),{code:'23514'});
    const removed=await reserve(db,s1,3,[line('source','A')]);
    assert.equal(removed.session.expires_at,deadline);
    assert.equal(removed.holds.length,1);
    await db.query('UPDATE complex_event SET available_seats=0 WHERE id=$1',[complex]);
    await db.query('UPDATE event SET total_capacity=10 WHERE id=$1',[source]);
    await db.query(`INSERT INTO sales_commercial_allocation VALUES($1,$2,$1,'simple',$3,'A')`,[allocation,tenant,source]);
    await assert.rejects(db.query(`INSERT INTO sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places)
      VALUES($1,$2,'allocated',2)`,[tenant,allocation]),{code:'23514'});
    await db.query(`INSERT INTO sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places)
      VALUES($1,$2,'allocated',1)`,[tenant,allocation]);
    await assert.rejects(db.query(`INSERT INTO booking(tenant_id,event_id,ticket_class_id,status) VALUES($1,$2,'A','confirmed')`,[tenant,source]),{code:'23514'});
    await db.query('BEGIN');
    await db.query(`INSERT INTO sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places)
      VALUES($1,$2,'named',1)`,[tenant,allocation]);
    await db.query(`INSERT INTO booking(tenant_id,event_id,ticket_class_id,status) VALUES($1,$2,'A','confirmed')`,[tenant,source]);
    await db.query('COMMIT');
    await assert.rejects(reserve(db,s1,4,[line('source','G',2)]),{code:'23514'});
    const group=await reserve(db,s1,4,[line('source','G')]);
    assert.equal(group.holds[0].places,2);
    assert.equal(group.session.expires_at,deadline);
    await assert.rejects(reserve(db,s1,5,[line('source','G')],true),{code:'PT409'});
    // Advance only disposable fixture timestamps, never sleep or change clocks.
    await db.query(`UPDATE event_funnel_session SET state='expired' WHERE id=$1`,[s1]);
    await db.query(`UPDATE event_funnel_session SET first_reserved_at=now()-interval '1 hour',expires_at=now()-interval '30 minutes',state='held' WHERE id=$1`,[s1]);
    await assert.rejects(reserve(db,s1,5,[line('source','G')]),{code:'PT409'});
    assert.equal((await db.query('SELECT event_funnel_expire_holds() n')).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*) FROM event_funnel_hold WHERE session_id=$1',[s1])).rows[0].count,'1');
    const renewed=await reserve(db,s1,6,[line('source','G')],true);
    assert.notEqual(renewed.session.expires_at,deadline);
    await db.query(`UPDATE event_funnel_session SET state='expired' WHERE id=$1`,[s1]);
    await db.query(`UPDATE event_funnel_session SET first_reserved_at=now()-interval '1 hour',expires_at=now()-interval '30 minutes',state='payment_uncertain' WHERE id=$1`,[s1]);
    assert.equal((await db.query('SELECT event_funnel_expire_holds() n')).rows[0].n,0);
    await assert.rejects(reserve(db,s3,1,[line('source','G')]),{code:'23514'});
    await assert.rejects(reserve(db,s1,7,[line('source','A')]),{code:'PT409'});
    for(const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(reserve(db,s3,1,[line('source','A')]),{code:'42501'});
      await assert.rejects(db.query('SELECT * FROM event_funnel_hold'),{code:'42501'});
      await db.query('RESET ROLE');
    }
    await db.query('SET ROLE service_role');
    await assert.rejects(db.query('SELECT * FROM event_funnel_hold'),{code:'42501'});
    await assert.rejects(db.query('SELECT event_funnel_held_places($1,\'simple\',$2)',[tenant,source]),{code:'42501'});
    assert.equal((await db.query('SELECT event_funnel_inventory_projection($1,\'simple\',$2) r',[tenant,[source]])).rows[0].r[0].places,2);
    await db.query('RESET ROLE');
    await exerciseFunnelJourney({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelPublication({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelOrders({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelCommit({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelTraining({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelVoucherFoundation({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelVoucherOrders({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelGroups({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelMaintenance({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelDiscovery({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelPurchasePolicy({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelLegacyIntent({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelInvoicePreparation({db,sql});
    await exerciseFunnelInvoiceDelivery({db,connect,sql});
    await exerciseFunnelQuickBooks({db,connect,sql});
    await exerciseFunnelInvoiceReaders({db,sql});
    await exerciseFunnelOwnedInvoices({db,sql});
    await exerciseFunnelConfirmations({db,sql});
    await exerciseFunnelConfirmationRetention({db,connect,sql});
    await exerciseFunnelIntegrations({db,sql,connect});
    await exerciseFunnelZoomRecovery({db,sql,connect});
    await exerciseFunnelMailgunReceipt({db,sql});
    await exerciseFunnelInventoryEvidence({db,sql,tenant,member});
    await exerciseFunnelReversalLedger({db,connect,sql});
    await exerciseFunnelTrainingRefund({db,connect,sql});
    await exerciseFunnelVoucherRefundPlan({db,connect,sql});
    await exerciseFunnelCancellationCommit({db,connect,sql});
    await exerciseFunnelReversalRecovery({db,sql});
    await exerciseFunnelIssuedInvoice({db,sql});
    await exerciseFunnelCreditStore({db,sql});
    await exerciseFunnelCreditProducer({db,sql,connect});
    await exerciseFunnelQuickBooksEvidence({db,sql});
    await exerciseFunnelQuickBooksCredit({db,sql});
    await exerciseFunnelRefundOptions({db,sql,connect});
    await exerciseFunnelReversalWorker({db,sql,connect});
    await exerciseFunnelSelectedVoucherRefunds({db,sql,connect});
    await exerciseFunnelCancellationApproval({db,sql,connect});
    await exerciseFunnelCancelledDelivery({db,sql,connect,tenant,member});
    await exerciseFunnelFinalGaps({db,sql,connect,tenant,member});
    await exerciseFunnelCreditEmails({db});
    if(process.env.TEST_ISOLATION_ALLOW_LOCAL_POSTGREST==='1') {
      await db.query('CREATE TABLE tenant(id uuid PRIMARY KEY)');
      await db.query('INSERT INTO tenant VALUES($1)',[tenant]);
      await db.query('GRANT USAGE ON SCHEMA public TO service_role');
      await db.query('GRANT SELECT ON tenant,event,complex_event TO service_role');
      await db.query(`UPDATE event_funnel_offer_policy SET unlisted=true WHERE tenant_id=$1 AND node_id='fixture-hidden-simple'`,[tenant]);
      gateway=await startAwardsPostgrest(h.socket,h.port);
      await assert.rejects(assertStandaloneEventOffer({db:gateway.client,tenantId:tenant,
        eventKind:'simple',eventId:uuid(600),ticketIds:['A']}),{code:'FUNNEL_PREREQUISITE_REQUIRED'});
      await assertStandaloneEventOffer({db:gateway.client,tenantId:tenant,
        eventKind:'simple',eventId:uuid(601),ticketIds:['default']});
      let query=gateway.client.from('event').select('id',{count:'exact'}).eq('tenant_id',tenant)
        .in('id',[uuid(600),uuid(601)]).order('id').range(0,0);
      ({query}=await scopeEventFunnelDiscovery({db:gateway.client,query}));
      const result=await query;
      assert.equal(result.error,null);assert.equal(result.count,1);
      assert.deepEqual(result.data,[{id:uuid(601)}]);
      const complexResult=await gateway.client.from('complex_event').select('id').eq('id',uuid(602))
        .eq('event_funnel_discoverable',true);
      assert.equal(complexResult.error,null);assert.deepEqual(complexResult.data,[]);
    }
    await exerciseFunnelActivation({db,sql});
    await exerciseFunnelTicketRouting({db,connect,uuid,tenant,member,sql});
    await exerciseFunnelCollections({db,uuid,tenant,sql});
    await exerciseFunnelDiscount({db,uuid,tenant,member,sql});
  } finally {
    if(gateway)await gateway.stop();
    await Promise.all(clients.map(c=>c.end()));
    if(started) run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
