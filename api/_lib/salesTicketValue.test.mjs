import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeGroupPayment, normalizeGroupPricePaid, normalizeGroupTicketPrices } from '../reports/_pricePaid.js';

test('allocated ordinary/complex rows display proposal value without changing payable fields', () => {
  for (const source of ['standard', 'complex']) {
    const rows = Array.from({ length: 4 }, () => ({
      _report_booking_source: source, total_cost: 0, ticket_price: 0, total_paid: 0,
      _proposal_ticket_value: { net_minor: 8333, tax_minor: 1667, gross_minor: 10000 },
    }));
    assert.deepEqual(normalizeGroupPricePaid(rows), rows.map(() => ({ price_paid: 100, price_paid_status: 'proposal_attributed' })));
    assert.deepEqual(normalizeGroupTicketPrices(rows), [100, 100, 100, 100]);
    assert.equal(normalizeGroupPayment(rows).totalAfterDiscount, 400);
    assert.equal(normalizeGroupPayment(rows).proposalAttributedTotal, 400);
    assert.ok(rows.every(row => row.total_cost === 0 && row.total_paid === 0));
  }
});

test('isolated PostgreSQL freezes values, apportions bundle/non-ticket weights, claims exact pennies and rejects replay', { timeout: 30000 }, async t => {
  const run = (bin, args, input) => {
    const result = spawnSync(bin, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const root = await mkdtemp(path.join(tmpdir(), 'ticket-value-'));
  const socket = path.join(root, 'socket');
  await mkdir(socket);
  let started = false;
  const args = ['-h', socket, '-p', '55449', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-q'];
  try {
    run('initdb', ['-D', path.join(root, 'data'), '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', path.join(root, 'data'), '-l', path.join(root, 'log'), '-o', `-F -k ${socket} -c listen_addresses= -p 55449`, '-w', 'start']);
    started = true;
    run('psql', args, `
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
      CREATE TABLE sales_quote_version(id uuid,tenant_id uuid,status text,currency text);
      CREATE TABLE sales_quote_line(id uuid,tenant_id uuid,quote_version_id uuid,net_minor bigint,tax_minor bigint);
      CREATE TABLE sales_quote_bundle_component(id uuid,tenant_id uuid,quote_line_id uuid,display_order int,quantity int,product_snapshot jsonb);
      CREATE TABLE sales_commercial_allocation(id uuid PRIMARY KEY,tenant_id uuid,quote_line_id uuid,bundle_component_id uuid,
        allocated_places int,event_reference_kind text,event_id uuid,ticket_type_id text,UNIQUE(tenant_id,id));
      CREATE TABLE sales_commercial_allocation_invitation(id uuid PRIMARY KEY,tenant_id uuid,allocation_id uuid,
        claimed_at timestamptz,released_at timestamptz,expires_at timestamptz,booking_kind text,booking_id uuid,
        token_hash bytea,delegate_email text,organization_id uuid);
      CREATE TABLE booking(id uuid,tenant_id uuid,event_id uuid,ticket_class_id text,attendee_email text,organization_id uuid,status text,total_cost numeric DEFAULT 0);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE sales_commercial_allocation_booking(tenant_id uuid,allocation_id uuid,booking_kind text,booking_id uuid,places int,designation text,booking_snapshot jsonb);
      CREATE TABLE sales_commercial_allocation_movement(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,allocation_id uuid,movement_kind text,
        places int,idempotency_key text,actor_kind text,actor_id uuid,metadata jsonb);
      CREATE FUNCTION guard_sales_commercial_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;
    `);
    const migration = await readFile(new URL('../../supabase/migrations/202610180009_sales_ticket_value_attribution.sql', import.meta.url), 'utf8');
    run('psql', args, migration);
    const hardened = await readFile(new URL('../../supabase/migrations/20260913_sales_concurrency_hardening.sql', import.meta.url), 'utf8');
    run('psql', args, hardened.slice(hardened.indexOf('CREATE OR REPLACE FUNCTION public.claim_sales_allocation_invitation('),
      hardened.indexOf('REVOKE ALL ON FUNCTION public.claim_sales_allocation_invitation')));
    run('psql', args, `
      DO $test$
      DECLARE tenant uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); l uuid:=gen_random_uuid();
        a uuid:=gen_random_uuid(); ev uuid:=gen_random_uuid(); b uuid; inv uuid; token text; kind text; amount bigint;
        bl uuid:=gen_random_uuid(); component uuid:=gen_random_uuid();
      BEGIN
        INSERT INTO sales_quote_version VALUES(v,tenant,'accepted','GBP');
        INSERT INTO sales_quote_line VALUES(l,tenant,v,33333,6667);
        INSERT INTO sales_commercial_allocation VALUES(a,tenant,l,NULL,4,'simple',ev,'ticket',NULL);
        FOR idx IN 1..4 LOOP
          b:=gen_random_uuid(); inv:=gen_random_uuid(); token:=repeat(idx::text,64);
          INSERT INTO booking(id,tenant_id,event_id,ticket_class_id,attendee_email,status) VALUES(b,tenant,ev,'ticket','a@test','confirmed');
          INSERT INTO sales_commercial_allocation_invitation(id,tenant_id,allocation_id,expires_at,token_hash,delegate_email)
            VALUES(inv,tenant,a,now()+interval '1 day',decode(token,'hex'),'a@test');
          PERFORM claim_sales_allocation_invitation(token,'simple',b);
          BEGIN
            PERFORM claim_sales_allocation_invitation(token,'simple',b);
            RAISE EXCEPTION 'replay accepted';
          EXCEPTION WHEN check_violation THEN NULL; END;
        END LOOP;
        IF (SELECT sum(gross_minor) FROM sales_allocation_ticket_value WHERE allocation_id=a)<>40000
          OR (SELECT sum(net_minor) FROM sales_allocation_ticket_value WHERE allocation_id=a)<>33333
          OR (SELECT sum(tax_minor) FROM sales_allocation_ticket_value WHERE allocation_id=a)<>6667 THEN
          RAISE EXCEPTION 'penny reconciliation failed'; END IF;
        IF EXISTS(SELECT 1 FROM sales_allocation_ticket_value WHERE allocation_id=a AND gross_minor<>10000) THEN
          RAISE EXCEPTION 'four £400 places must each be £100'; END IF;
        IF EXISTS(SELECT 1 FROM booking WHERE total_cost<>0) THEN RAISE EXCEPTION 'payable changed'; END IF;
        BEGIN
          UPDATE sales_allocation_ticket_value SET net_minor=0;
          RAISE EXCEPTION 'mutation accepted';
        EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'immutable' THEN RAISE; END IF; END;
        -- A £100 bundle includes a ticket (£30 weight) and non-ticket (£70).
        INSERT INTO sales_quote_line VALUES(bl,tenant,v,10000,0);
        INSERT INTO sales_quote_bundle_component VALUES(component,tenant,bl,0,1,'{"standard_price_minor":3000}'),
          (gen_random_uuid(),tenant,bl,1,1,'{"standard_price_minor":7000}');
        a:=gen_random_uuid();
        INSERT INTO sales_commercial_allocation VALUES(a,tenant,bl,component,3,'complex',ev,'group',NULL);
        IF (SELECT (proposal_value_snapshot->>'grossMinor')::bigint FROM sales_commercial_allocation WHERE id=a)<>3000 THEN
          RAISE EXCEPTION 'non-ticket bundle value leaked'; END IF;
        FOR idx IN 5..7 LOOP
          b:=gen_random_uuid(); inv:=gen_random_uuid(); token:=repeat(idx::text,64);
          INSERT INTO complex_event_booking(id,tenant_id,event_id,ticket_class_id,attendee_email,status) VALUES(b,tenant,ev,'group','a@test','confirmed');
          INSERT INTO sales_commercial_allocation_invitation(id,tenant_id,allocation_id,expires_at,token_hash,delegate_email)
            VALUES(inv,tenant,a,now()+interval '1 day',decode(token,'hex'),'a@test');
          PERFORM claim_sales_allocation_invitation(token,'complex',b);
        END LOOP;
        IF (SELECT sum(gross_minor) FROM sales_allocation_ticket_value WHERE allocation_id=a)<>3000 THEN
          RAISE EXCEPTION 'group value mismatch'; END IF;
        -- New sale with 10p over three places: 3p/3p/4p, with exact tax.
        l:=gen_random_uuid(); a:=gen_random_uuid();
        INSERT INTO sales_quote_line VALUES(l,tenant,v,8,2);
        INSERT INTO sales_commercial_allocation VALUES(a,tenant,l,NULL,3,'simple',ev,'rounding',NULL);
        FOR idx IN 8..10 LOOP
          b:=gen_random_uuid(); inv:=gen_random_uuid(); token:=md5(idx::text)||md5(idx::text);
          INSERT INTO booking(id,tenant_id,event_id,ticket_class_id,attendee_email,status) VALUES(b,tenant,ev,'rounding','a@test','confirmed');
          INSERT INTO sales_commercial_allocation_invitation(id,tenant_id,allocation_id,expires_at,token_hash,delegate_email)
            VALUES(inv,tenant,a,now()+interval '1 day',decode(token,'hex'),'a@test');
          IF idx=8 THEN
            UPDATE booking SET status='cancelled' WHERE id=b;
            BEGIN
              PERFORM claim_sales_allocation_invitation(token,'simple',b);
              RAISE EXCEPTION 'cancelled claim accepted';
            EXCEPTION WHEN check_violation THEN NULL; END;
            UPDATE booking SET status='confirmed' WHERE id=b;
          END IF;
          PERFORM claim_sales_allocation_invitation(token,'simple',b);
        END LOOP;
        IF (SELECT array_agg(gross_minor ORDER BY place_index) FROM sales_allocation_ticket_value WHERE allocation_id=a)<>ARRAY[3,3,4]::bigint[]
          OR (SELECT sum(net_minor) FROM sales_allocation_ticket_value WHERE allocation_id=a)<>8
          OR (SELECT sum(tax_minor) FROM sales_allocation_ticket_value WHERE allocation_id=a)<>2 THEN
          RAISE EXCEPTION 'fractional penny distribution failed'; END IF;
        -- No component price evidence means an explicit rejection, not an
        -- equal split silently transferring non-ticket revenue to attendees.
        UPDATE sales_quote_bundle_component SET product_snapshot='{}' WHERE id=component;
        BEGIN
          INSERT INTO sales_commercial_allocation VALUES(gen_random_uuid(),tenant,bl,component,3,'complex',ev,'ambiguous',NULL);
          RAISE EXCEPTION 'ambiguous bundle accepted';
        EXCEPTION WHEN check_violation THEN NULL; END;
      END $test$;
    `);
  } finally {
    if (started) run('pg_ctl', ['-D', path.join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
