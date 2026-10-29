import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

test('policy migration: exact tenant emails, private execution, defaults, idempotency and existing uniqueness', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-ticket-policy-pg-'));
  const cluster = join(root, 'data');
  let started = false;
  let db;
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(root, 'postgres.log'), '-o', `-k ${root} -p 55562 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    db = new pg.Client({ host: root, port: 55562, user: 'runner', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.role (
        id uuid PRIMARY KEY, tenant_id uuid, is_admin boolean DEFAULT false,
        is_tenant_admin boolean DEFAULT false, requires_effective_from_date boolean DEFAULT false,
        max_members integer
      );
      CREATE TABLE public.member (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, email text NOT NULL,
        login_enabled boolean DEFAULT true, status text DEFAULT 'active',
        first_name text, last_name text, organization_id uuid, role_id uuid,
        show_in_directory boolean DEFAULT true
      );
      CREATE UNIQUE INDEX member_email_tenant_unique_ci_idx
        ON public.member(tenant_id, lower(TRIM(BOTH FROM email)));
      CREATE TABLE public.complex_event_ticket_class(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.booking(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, event_id uuid,
        member_id uuid, organization_id uuid, status text, created_at timestamptz DEFAULT now(),
        ticket_class_id text, attendee_email text, attendee_first_name text, attendee_last_name text,
        payment_method text, stripe_payment_intent_id text
      );
      CREATE TABLE public.complex_event_booking(LIKE public.booking INCLUDING ALL);
    `);
    const sql = await readFile(new URL('../../supabase/migrations/20261005120000_public_ticket_member_policy.sql', import.meta.url), 'utf8');
    await db.query(sql);
    await db.query(sql);
    assert.equal((await db.query('SELECT public.normalize_public_ticket_email($1) AS email', ['\vV@example.com\v'])).rows[0].email, 'v@example.com');
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';
    await db.query("INSERT INTO public.booking(id,tenant_id,event_id,status,payment_method) VALUES($1,$1,$1,'confirmed','free')", [a]);
    await db.query(`INSERT INTO public.member(tenant_id,email,login_enabled,status) VALUES
      ($1,' A_*%@EXAMPLE.COM ',false,'inactive'), ($1,'axanything@example.com',true,'active'),
      ($2,'other@example.com',false,'inactive')`, [a, b]);
    await db.query('SET ROLE service_role');
    const found = await db.query('SELECT * FROM public.lookup_public_ticket_member_emails($1,$2)', [a, ['a_*%@example.com', 'other@example.com']]);
    assert.deepEqual(found.rows, [{ normalized_email: 'a_*%@example.com' }]);
    assert.equal((await db.query('SELECT * FROM public.lookup_public_ticket_member_emails($1,$2)', [b, ['a_*%@example.com']])).rowCount, 0);
    await assert.rejects(db.query('SELECT * FROM public.lookup_public_ticket_member_emails($1,$2)', [a, []]), { code: '22023' });
    await db.query('RESET ROLE');
    for (const untrusted of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${untrusted}`);
      await assert.rejects(db.query('SELECT * FROM public.lookup_public_ticket_member_emails($1,$2)', [a, ['a_*%@example.com']]), { code: '42501' });
      await db.query('RESET ROLE');
    }
    assert.equal((await db.query('INSERT INTO public.complex_event_ticket_class DEFAULT VALUES RETURNING create_member_records')).rows[0].create_member_records, false);
    await assert.rejects(db.query('INSERT INTO public.member(tenant_id,email) VALUES($1,$2)', [a, 'a_*%@example.com']), { code: '23505' });
    await db.query('INSERT INTO public.member(tenant_id,email) VALUES($1,$2)', [b, 'a_*%@example.com']);
    const evidenceSql = await readFile(new URL('../../supabase/migrations/20261005121000_public_ticket_member_evidence.sql', import.meta.url), 'utf8');
    await db.query(evidenceSql);
    await db.query(evidenceSql);
    const roleId = '00000000-0000-4000-8000-000000000010';
    await db.query('INSERT INTO public.role(id,tenant_id) VALUES ($1,$2)', [roleId, a]);
    const makeSnapshot = emails => ({
      version: 1, tenant_id: a, people: emails.map(email => ({
        identity: { email, first_name: 'Test', last_name: 'Contact', organization: 'Supplied, not verified' },
        role_id: roleId, links: [{ kind: 'purchaser' }, { kind: 'attendee', ticket_id: 'test-ticket', index: 0 }],
      })),
    });
    const prepare = async (id, emails, state = 'ready', evidence = { status: 'free', complete_batch: true }) => {
      await db.query(`INSERT INTO public.public_ticket_member_purchase
        (id,tenant_id,event_id,event_kind,snapshot,state,booking_ids,completion_evidence)
        VALUES($1,$2,$2,'simple',$3,$4,ARRAY[$2::uuid],$5)`, [id, a, makeSnapshot(emails), state, evidence]);
    };
    const provision = async id => {
      await db.query('SET ROLE service_role');
      try { return (await db.query('SELECT public.provision_public_ticket_members($1) AS result', [id])).rows[0].result; }
      finally { await db.query('RESET ROLE'); }
    };
    const firstPurchase = '00000000-0000-4000-8000-000000000101';
    await prepare(firstPurchase, ['new@example.com']);
    assert.deepEqual(await provision(firstPurchase), { state: 'completed', created: 1 });
    assert.deepEqual(await provision(firstPurchase), { state: 'completed', replayed: true });
    const contact = (await db.query("SELECT * FROM public.member WHERE email='new@example.com'")).rows[0];
    assert.equal(contact.login_enabled, false);
    assert.equal(contact.show_in_directory, false);
    assert.equal(contact.organization_id, null);
    assert.equal(contact.supplied_organization_name, 'Supplied, not verified');
    assert.equal((await db.query('SELECT * FROM public.public_ticket_member_link WHERE purchase_id=$1', [firstPurchase])).rowCount, 1);
    await assert.rejects(db.query('UPDATE public.public_ticket_member_purchase SET snapshot=$1 WHERE id=$2',
      [makeSnapshot(['different@example.com']), firstPurchase]), { code: '23514' });
    await assert.rejects(db.query("UPDATE public.public_ticket_member_purchase SET state='ready' WHERE id=$1",
      [firstPurchase]), { code: '23514' });
    const preparationId = '00000000-0000-4000-8000-000000000106';
    const preparationArgs = [preparationId, a, a, 'simple', makeSnapshot(['prepared@example.com'])];
    const prepareSql = 'SELECT public.prepare_public_ticket_member_purchase($1,$2,$3,$4,$5) AS receipt';
    assert.equal((await db.query(prepareSql, preparationArgs)).rows[0].receipt.state, 'prepared');
    assert.equal((await db.query(prepareSql, preparationArgs)).rows[0].receipt.state, 'prepared');
    await assert.rejects(db.query(prepareSql, [...preparationArgs.slice(0, 4), makeSnapshot(['changed@example.com'])]), { code: '23514' });
    const duplicate = '00000000-0000-4000-8000-000000000102';
    await prepare(duplicate, ['rolled-back@example.com', 'new@example.com']);
    assert.deepEqual(await provision(duplicate), { state: 'conflict', code: 'external_duplicate', created: 0 });
    assert.equal((await db.query("SELECT 1 FROM public.member WHERE email='rolled-back@example.com'")).rowCount, 0);
    assert.equal((await db.query('SELECT 1 FROM public.public_ticket_member_link WHERE purchase_id=$1', [duplicate])).rowCount, 0);
    const unready = '00000000-0000-4000-8000-000000000103';
    await prepare(unready, ['unready@example.com'], 'prepared');
    assert.deepEqual(await provision(unready), { state: 'prepared', created: 0 });
    const unpaid = '00000000-0000-4000-8000-000000000104';
    await prepare(unpaid, ['unpaid@example.com'], 'ready', { status: 'requires_capture', complete_batch: true });
    assert.deepEqual(await provision(unpaid), { state: 'conflict', code: 'invalid_completion_evidence', created: 0 });
    const changedRole = '00000000-0000-4000-8000-000000000105';
    await prepare(changedRole, ['changed-role@example.com']);
    await db.query('UPDATE public.role SET is_admin=true WHERE id=$1', [roleId]);
    assert.deepEqual(await provision(changedRole), { state: 'conflict', code: 'role_policy_conflict', created: 0 });
    await db.query('UPDATE public.role SET is_admin=false WHERE id=$1', [roleId]);
    const racingIds = ['00000000-0000-4000-8000-000000000110', '00000000-0000-4000-8000-000000000111'];
    for (const id of racingIds) await prepare(id, ['concurrent@example.com']);
    const concurrent = new pg.Client({ host: root, port: 55562, user: 'runner', database: 'postgres' });
    await concurrent.connect();
    try {
      const results = await Promise.all([
        db.query('SELECT public.provision_public_ticket_members($1) AS outcome', [racingIds[0]]),
        concurrent.query('SELECT public.provision_public_ticket_members($1) AS outcome', [racingIds[1]]),
      ]);
      assert.deepEqual(results.map(result => result.rows[0].outcome.state).sort(), ['completed', 'conflict']);
      assert.equal((await db.query("SELECT 1 FROM public.member WHERE email='concurrent@example.com'")).rowCount, 1);
      const winner = results.findIndex(result => result.rows[0].outcome.state === 'completed');
      assert.equal((await provision(racingIds[winner])).replayed, true);
    } finally { await concurrent.end(); }
    await assert.rejects(db.query(
      'INSERT INTO public.member(tenant_id,email) VALUES($1,$2)', [a, '\tCONCURRENT@example.com\u00a0'],
    ), { code: '23505' });
    for (const untrusted of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${untrusted}`);
      await assert.rejects(db.query('SELECT public.provision_public_ticket_members($1)', [firstPurchase]), { code: '42501' });
      await assert.rejects(db.query('SELECT * FROM public.public_ticket_member_purchase'), { code: '42501' });
      await db.query('RESET ROLE');
    }
    await db.query(`
      CREATE TABLE public.event(id uuid PRIMARY KEY, tenant_id uuid, available_seats integer,
        is_unlimited_registration boolean DEFAULT false, status text DEFAULT 'published');
      CREATE TABLE public.complex_event(LIKE public.event INCLUDING ALL);
      CREATE TABLE IF NOT EXISTS public.booking(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, event_id uuid,
        member_id uuid, organization_id uuid, status text, created_at timestamptz DEFAULT now(),
        ticket_class_id text, attendee_email text, attendee_first_name text, attendee_last_name text,
        payment_method text, stripe_payment_intent_id text
      );
      CREATE TABLE IF NOT EXISTS public.complex_event_booking(LIKE public.booking INCLUDING ALL);
      CREATE FUNCTION public.check_oneoff_ticket_capacity(uuid,text,integer,uuid[])
        RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ok":true}'::jsonb $$;
      CREATE FUNCTION public.check_complex_event_ticket_capacity(uuid,text,integer,uuid[])
        RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ok":true}'::jsonb $$;
    `);
    const batchSql = await readFile(new URL('../../supabase/migrations/20261005122000_public_ticket_member_booking_batch.sql', import.meta.url), 'utf8');
    await db.query('DELETE FROM public.booking');
    await db.query(batchSql);
    await db.query(batchSql);
    await db.query('INSERT INTO public.event(id,tenant_id,available_seats) VALUES($1,$1,2)', [a]);
    const batchId = '00000000-0000-4000-8000-000000000107';
    const batchSnapshot = { ...makeSnapshot(['batch@example.com']), booking_items: [{
      ticket_id: 'ticket', attendees: [{ email: 'batch@example.com', first_name: 'Test', last_name: 'Contact' }],
    }] };
    await db.query(prepareSql, [batchId, a, a, 'simple', batchSnapshot]);
    const bookingRow = {
      ticket_class_id: 'ticket', attendee_email: 'batch@example.com',
      attendee_first_name: 'Test', attendee_last_name: 'Contact', payment_method: 'free',
    };
    const invokeBatch = 'SELECT public.insert_public_ticket_booking_batch($1,$2) AS rows';
    const firstBatch = (await db.query(invokeBatch, [batchId, JSON.stringify([bookingRow])])).rows[0].rows;
    const secondBatch = (await db.query(invokeBatch, [batchId, JSON.stringify([bookingRow])])).rows[0].rows;
    assert.deepEqual(secondBatch, firstBatch);
    assert.equal(firstBatch[0].member_id, null);
    assert.equal(firstBatch[0].organization_id, null);
    assert.equal((await db.query('SELECT available_seats FROM public.event WHERE id=$1', [a])).rows[0].available_seats, 1);
    assert.equal((await db.query('SELECT * FROM public.booking')).rowCount, 1);
    // Permanent capacity loss is durable even without any booking IDs, making
    // captured-payment compensation independently discoverable.
    await db.query('UPDATE public.event SET available_seats=0 WHERE id=$1', [a]);
    const soldOutId = '00000000-0000-4000-8000-000000000112';
    await db.query(prepareSql, [soldOutId, a, a, 'simple', batchSnapshot]);
    await db.query("UPDATE public.public_ticket_member_purchase SET stripe_payment_intent_id='pi_sold_out' WHERE id=$1", [soldOutId]);
    assert.deepEqual((await db.query(invokeBatch, [soldOutId, JSON.stringify([{
      ...bookingRow, payment_method: 'card', stripe_payment_intent_id: 'pi_sold_out',
    }])])).rows[0].rows, { error: 'capacity_unavailable' });
    const stranded = (await db.query('SELECT state,last_error_code,booking_ids FROM public.public_ticket_member_purchase WHERE id=$1', [soldOutId])).rows[0];
    assert.deepEqual(stranded, { state: 'retryable', last_error_code: 'capacity_refund_pending', booking_ids: [] });
    await db.query('UPDATE public.event SET available_seats=1 WHERE id=$1', [a]);
    const badBatchId = '00000000-0000-4000-8000-000000000108';
    await db.query(prepareSql, [badBatchId, a, a, 'simple', batchSnapshot]);
    await assert.rejects(db.query(invokeBatch, [badBatchId, JSON.stringify([{ ...bookingRow, attendee_email: 'forged@example.com' }])]), { code: '23514' });
    assert.equal((await db.query('SELECT available_seats FROM public.event WHERE id=$1', [a])).rows[0].available_seats, 1);
    assert.equal((await db.query('SELECT * FROM public.booking')).rowCount, 1);
    await db.query(`CREATE TABLE public.organization(id uuid PRIMARY KEY,tenant_id uuid,name text);
      CREATE TABLE public.organization_group(LIKE public.organization INCLUDING ALL);
      CREATE TABLE public.preference_field(id uuid PRIMARY KEY,tenant_id uuid,entity_scope text);
      CREATE TABLE public.organization_preference_value(organization_id uuid,field_id uuid,value text);
      CREATE TABLE public.organization_group_preference_value(tenant_id uuid,organization_group_id uuid,field_id uuid,value text);
      ALTER TABLE member ADD COLUMN organization_group_id uuid;
      ALTER TABLE event ADD COLUMN IF NOT EXISTS status text DEFAULT 'published';
      ALTER TABLE event ADD COLUMN IF NOT EXISTS pricing_config jsonb DEFAULT '{}';`);
    for(const name of ['202612090005_event_registration_associations.sql','202612090006_event_registration_association_accounts.sql'])
      await db.query(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
    await db.query('GRANT SELECT,UPDATE ON event TO anon,authenticated; GRANT SELECT,UPDATE ON event TO service_role');
    for(const untrusted of ['anon','authenticated']){
      await db.query(`SET ROLE ${untrusted}`);
      await assert.rejects(db.query("UPDATE event SET registration_association_config='{}' WHERE id=$1",[a]),{code:'42501'});
      await db.query('RESET ROLE');
    }
    await db.query(`INSERT INTO organization_group VALUES($1,$1,'Allowed Group'),($2,$2,'Another tenant');
      `,[a,b]);
    await db.query('SET ROLE service_role');
    await db.query('UPDATE event SET registration_association_config=$2 WHERE id=$1',
      [a,{groups:{enabled:true},organizations:{enabled:false},role_id:roleId}]);
    await db.query('RESET ROLE');
    const choices=(await db.query("SELECT event_registration_association_options($1,$1,false) choices",[a])).rows[0].choices;
    assert.deepEqual(choices.options,[{kind:'group',id:a,name:'Allowed Group'}]);
    await db.query("INSERT INTO preference_field VALUES($1,$1,'organization_group')",[a]);
    await db.query("INSERT INTO organization_group_preference_value VALUES($1,$1,$1,'[\"Eligible\",\"Other value\"]')",[a]);
    await db.query('UPDATE event SET registration_association_config=$2 WHERE id=$1',
      [a,{groups:{enabled:true,field_id:a,value:'Eligible'},organizations:{enabled:false},role_id:roleId}]);
    assert.equal((await db.query("SELECT event_registration_association_options($1,$1,false) choices",[a])).rows[0].choices.options.length,1);
    await db.query('UPDATE event SET registration_association_config=$2 WHERE id=$1',
      [a,{groups:{enabled:true,field_id:a,value:'Not eligible'},organizations:{enabled:false},role_id:roleId}]);
    assert.equal((await db.query("SELECT event_registration_association_options($1,$1,false) choices",[a])).rows[0].choices.options.length,0);
    await db.query('SET ROLE authenticated');
    await assert.rejects(db.query("SELECT event_registration_association_options($1,$1,false)",[a]),{code:'42501'});
    await db.query('RESET ROLE');
    await db.query(`INSERT INTO booking(id,tenant_id,event_id,status,payment_method) VALUES($1,$1,$1,'confirmed','public_invoice_po')`,[a]);
    // Match the real schema: organisation values do not have tenant_id.
    await db.query("INSERT INTO organization VALUES($1,$1,'Allowed Organisation'),($2,$2,'Other tenant organisation')",[a,b]);
    await db.query('UPDATE event SET registration_association_config=$2 WHERE id=$1',
      [a,{organizations:{enabled:true},groups:{enabled:false},role_id:roleId}]);
    await assert.rejects(db.query("SELECT event_registration_association_options($1,$1,false)",[a]),{code:'42703'});
    await db.query(await readFile(new URL('../../supabase/migrations/202612090009_registration_association_value_scope.sql',import.meta.url),'utf8'));
    const orgField='00000000-0000-4000-8000-000000000301';
    await db.query("INSERT INTO preference_field VALUES($1,$2,'organization')",[orgField,a]);
    await db.query("INSERT INTO organization_preference_value VALUES($1,$3,'[\"Eligible\"]'),($2,$3,'Eligible')",[a,b,orgField]);
    const lookup=async()=> (await db.query("SELECT event_registration_association_options($1,$1,false) choices",[a])).rows[0].choices;
    assert.deepEqual((await lookup()).options,[{kind:'organization',id:a,name:'Allowed Organisation'}]);
    await db.query('UPDATE event SET registration_association_config=$2 WHERE id=$1',
      [a,{organizations:{enabled:true,field_id:orgField,value:'Eligible'},groups:{enabled:true,field_id:a,value:'Eligible'},role_id:roleId}]);
    assert.deepEqual((await lookup()).options.map(o=>o.kind),['group','organization']);
    await db.query("UPDATE organization_group_preference_value SET tenant_id=$1",[b]);
    assert.deepEqual((await lookup()).options.map(o=>o.kind),['organization']);
    await db.query("UPDATE organization_group_preference_value SET tenant_id=$1",[a]);
    await db.query('UPDATE event SET registration_association_config=$2 WHERE id=$1',
      [a,{organizations:{enabled:true,field_id:orgField,value:'Missing'},groups:{enabled:false},role_id:roleId}]);
    assert.equal((await lookup()).options.length,0);
    await db.query("UPDATE preference_field SET tenant_id=$1 WHERE id=$2",[b,orgField]);
    await assert.rejects(lookup(),/Filter field unavailable/);
    await db.query(await readFile(new URL('../../supabase/migrations/202612090010_registration_association_complete_options.sql',import.meta.url),'utf8'));
    await db.query(`INSERT INTO organization SELECT md5('extra-org-'||n)::uuid,$1,'Extra org '||lpad(n::text,3,'0') FROM generate_series(1,60) n;
      `,[a]);
    await db.query(`INSERT INTO organization_group SELECT md5('extra-group-'||n)::uuid,$1,'Extra group '||lpad(n::text,3,'0') FROM generate_series(1,60) n`,[a]);
    await db.query('UPDATE event SET registration_association_config=$2 WHERE id=$1',
      [a,{organizations:{enabled:true},groups:{enabled:true},role_id:roleId}]);
    const completeOptions=await lookup();
    assert.equal(completeOptions.options.length,122);
    assert.equal(completeOptions.hasMore,false);
    assert.equal(completeOptions.options.filter(o=>o.kind==='organization').length,61);
    assert.ok(completeOptions.options.every(o=>o.id!==b));
    const searched=(await db.query("SELECT event_registration_association_options($1,$1,false,'Extra org 060') choices",[a])).rows[0].choices;
    assert.equal(searched.options.length,1);
    assert.equal(searched.options[0].name,'Extra org 060');
    for(const role of ['anon','authenticated']){
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(lookup(),{code:'42501'});
      await db.query('RESET ROLE');
    }
    await db.query('UPDATE event SET registration_association_config=$2 WHERE id=$1',
      [a,{groups:{enabled:true,field_id:a,value:'Eligible'},organizations:{enabled:false},role_id:roleId}]);
    await db.query('SET ROLE service_role');
    assert.deepEqual((await lookup()).options,[{kind:'group',id:a,name:'Allowed Group'}]);
    await db.query('RESET ROLE');
    const associatedSnapshot=makeSnapshot(['associated@example.invalid']);
    associatedSnapshot.association_role_id=roleId;
    associatedSnapshot.people[0].association={kind:'group',id:a,name:'Allowed Group'};
    const associatedPurchase='00000000-0000-4000-8000-000000000211';
    await db.query(`INSERT INTO public_ticket_member_purchase(id,tenant_id,event_id,event_kind,snapshot,state,booking_ids,completion_evidence)
      VALUES($1,$2,$2,'simple',$3,'ready',ARRAY[$2::uuid],'{"status":"unpaid","complete_batch":true}')`,
      [associatedPurchase,a,associatedSnapshot]);
    assert.deepEqual(await provision(associatedPurchase),{state:'completed',created:1});
    const associatedMember=(await db.query("SELECT * FROM member WHERE email='associated@example.invalid'")).rows[0];
    assert.equal(associatedMember.login_enabled,true);
    assert.equal(associatedMember.organization_group_id,a);
    assert.equal(associatedMember.organization_id,null);
    assert.equal(associatedMember.role_id,roleId);
    assert.equal((await provision(associatedPurchase)).replayed,true);
    // Legacy unpaid contacts remain excluded, and association never constitutes
    // invoice creation or financial settlement.
    await prepare('00000000-0000-4000-8000-000000000212',['other-po@example.invalid'],'ready',{status:'unpaid',complete_batch:true});
    assert.notEqual((await provision('00000000-0000-4000-8000-000000000212')).state,'completed');
    assert.equal((await db.query("SELECT * FROM member WHERE email='other-po@example.invalid'")).rowCount,0);
    const defaultSnapshot={...batchSnapshot,association_role_id:roleId,
      booking_items:[{...batchSnapshot.booking_items[0],ticket_id:'default'}]};
    await db.query('UPDATE event SET available_seats=2,pricing_config=$2 WHERE id=$1',[a,{}]);
    const defaultId='00000000-0000-4000-8000-000000000213';
    await db.query(prepareSql,[defaultId,a,a,'simple',defaultSnapshot]);
    assert.equal((await db.query(invokeBatch,[defaultId,JSON.stringify([{...bookingRow,ticket_class_id:null}])])).rows[0].rows.length,1);
  } finally {
    if (db) await db.end();
    if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(root, { recursive: true, force: true });
  }
});
