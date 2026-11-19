import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { runTransaction } from './apply-simple-event-total-capacity.mjs';
import { migrationPath,functions,snapshot,state } from './lib/simpleEventCapacityRollout.mjs';

test('real PostgreSQL rehearsal rolls back every patch; apply preserves events; replay verifies only',
  {timeout:60000},async () => {
    const h=await createLocalPostgresHarness('capacity-rollout-');
    const run=(cmd,args)=>execFileSync(cmd,args,{stdio:'pipe'});
    let started=false, db;
    const sql=await readFile(migrationPath,'utf8');
    try {
      run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
      run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',
        `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);
      started=true;
      db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
      await db.connect();
      await db.query(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE event(id uuid PRIMARY KEY,tenant_id uuid,available_seats bigint,
          is_unlimited_registration boolean,is_complex boolean,pricing_config jsonb);
        CREATE TABLE booking(id uuid PRIMARY KEY,event_id uuid,tenant_id uuid,status text,ticket_class_id text);
        CREATE TABLE sales_commercial_allocation(id uuid,tenant_id uuid,event_id uuid,event_reference_kind text);
        CREATE TABLE sales_commercial_allocation_movement(allocation_id uuid,tenant_id uuid);
        CREATE TABLE sales_commercial_allocation_invitation(id uuid,tenant_id uuid,allocation_id uuid,token_hash bytea);
        CREATE VIEW sales_commercial_allocation_totals AS SELECT tenant_id,event_id,event_reference_kind,
          0::bigint remaining,0::bigint named,0::bigint reserved FROM sales_commercial_allocation;
        CREATE TABLE public_ticket_member_purchase(id uuid,event_id uuid,event_kind text,
          state text,stripe_payment_intent_id text,last_error_code text,updated_at timestamptz);
        INSERT INTO event VALUES
          ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',146,false,false,'{}');
      `);
      // These stubs model the signatures and patch anchors, not live commerce.
      // Behavioral capacity tests live in api/_lib/simpleEventCapacity.postgres.test.mjs.
      const stubs=[
        ['sales_capacity_state(p_event_kind text,p_event_id uuid,p_ticket_type_id text)',
          '',"  PERFORM pg_advisory_xact_lock(1);"],
        ['check_oneoff_ticket_capacity(p_event_id uuid,p_ticket_class_id text,p_requested integer,p_booking_ids uuid[])',
          'DECLARE s jsonb;', " s:=public.sales_capacity_state('simple',p_event_id,p_ticket_class_id);"],
        ['insert_public_ticket_booking_batch(p_purchase_id uuid,p_rows jsonb)',
          'DECLARE purchase public.public_ticket_member_purchase; ticket jsonb; expected_count integer;',
          "  FOR ticket IN SELECT '{}'::jsonb LOOP NULL; END LOOP;"],
        ['move_sales_commercial_allocation(p_tenant_id uuid,p_allocation_id uuid,p_kind text,p_places integer,p_idempotency_key text,p_reason text,p_actor_kind text,p_actor_id uuid)'],
        ['reconcile_sales_commercial_booking(p_tenant_id uuid,p_allocation_id uuid,p_booking_kind text,p_booking_id uuid,p_designation text,p_places integer,p_idempotency_key text,p_actor_kind text,p_actor_id uuid)'],
        ['unreconcile_sales_commercial_booking(p_tenant_id uuid,p_booking_kind text,p_booking_id uuid,p_idempotency_key text,p_actor_kind text,p_actor_id uuid)'],
        ['cancel_event_booking_with_allocation(p_tenant_id uuid,p_booking_kind text,p_booking_id uuid,p_idempotency_key text,p_actor_kind text,p_actor_id uuid)'],
        ['reserve_sales_allocation_invitation(p_tenant_id uuid,p_allocation_id uuid,p_token_hash text,p_delegate_email text,p_delegate_first_name text,p_delegate_last_name text,p_expires_at timestamptz,p_idempotency_key text,p_actor_kind text,p_actor_id uuid)'],
        ['claim_sales_allocation_invitation(p_token_hash text,p_booking_kind text,p_booking_id uuid)'],
        ['release_sales_allocation_invitation(p_tenant_id uuid,p_invitation_id uuid,p_actor_kind text,p_actor_id uuid)'],
        ['confirm_sales_quote_sale(p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_idempotency_key text,p_actor_kind text,p_actor_id uuid)'],
        ['confirm_sales_quote_ticket_sale(p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_idempotency_key text,p_actor_kind text,p_actor_id uuid)',
          '', '-- pg_temp.sale_candidates\n-- Every transaction takes all ticket locks'],
      ];
      for (const [signature,decl='',body=''] of stubs) await db.query(
        `CREATE FUNCTION public.${signature} RETURNS jsonb LANGUAGE plpgsql AS $$\n${decl}\nBEGIN\n${body}\nRETURN '{}'::jsonb;\nEND $$`);
      const original=await functions(db), before=await snapshot(db);
      assert.equal((await runTransaction(db,'--preflight',sql)).writesPerformed,false);
      assert.equal((await runTransaction(db,'--rehearse',sql)).rehearsed,true);
      assert.equal(await state(db),'absent');
      assert.deepEqual(await functions(db),original);
      assert.deepEqual(await snapshot(db),before);
      const disconnectedCommit = {query:async (...args) => {
        if (args[0] === 'COMMIT') throw new Error('Simulated lost COMMIT response');
        return db.query(...args);
      }};
      await assert.rejects(runTransaction(disconnectedCommit,'--apply',sql),
        error => error.commitOutcomeUnknown === true);
      assert.equal(await state(db),'absent');
      assert.deepEqual(await snapshot(db),before);
      const applied=await runTransaction(db,'--apply',sql);
      assert.equal(applied.applied,true);
      assert.equal(applied.preservation.events,1);
      const after=await snapshot(db);
      assert.equal(after[0].available_seats,'146');
      assert.equal(after[0].capacity_mode,'legacy');
      assert.equal(after[0].total_capacity,null);
      assert.equal(after[0].row_version,before[0].row_version);
      assert.equal((await runTransaction(db,'--apply',sql)).alreadyPresent,true);
      assert.equal((await runTransaction(db,'--verify',sql)).applied,false);
      assert.deepEqual(await snapshot(db),after);
      // A modified fragment is not accepted as a complete installation.
      await db.query(`CREATE OR REPLACE FUNCTION public.sales_capacity_state(p_event_kind text,p_event_id uuid,p_ticket_type_id text)
        RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN '{}'::jsonb; END $$`);
      await assert.rejects(runTransaction(db,'--apply',sql),/Incomplete capacity patch/);
    } finally {
      if(db) await db.end();
      if(started) run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
      await h.cleanup();
    }
  });
