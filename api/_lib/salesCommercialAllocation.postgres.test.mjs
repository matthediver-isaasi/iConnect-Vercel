import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrationPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260910_sales_commercial_allocation.sql',
  import.meta.url,
));
const deliveryMigrationPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260911_sales_quote_delivery.sql',
  import.meta.url,
));
const sql = await readFile(migrationPath, 'utf8');

function executable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function psql(command, args, input = '') {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function psqlAsync(command, args, input) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function has(pattern, message) {
  assert.match(sql, pattern, message);
}

test('commercial allocation migration has one tenant-scoped allocation target per sold item', () => {
  has(/CREATE TABLE public\.sales_commercial_sale[\s\S]*tenant_id uuid NOT NULL/i);
  has(/UNIQUE \(tenant_id, quote_id\)/i);
  has(/sales_allocation_line_once[\s\S]*WHERE bundle_component_id IS NULL/i);
  has(/sales_allocation_component_once[\s\S]*WHERE bundle_component_id IS NOT NULL/i);
  has(/JOIN public\.sales_quote_bundle_component[\s\S]*p\.event_id IS NOT NULL/i);
  has(/quote_line_id,candidate\.component_id/i);
});

test('confirm is atomic, idempotent, lock ordered, and covers mixed-line rollback', () => {
  has(/confirm_sales_quote_sale\(/i);
  has(/tenant_id=p_tenant_id AND idempotency_key=p_idempotency_key/i);
  has(/ORDER BY event_reference_kind,event_id,ticket_type_id/i);
  has(/pg_advisory_xact_lock/i);
  has(/commercial allocation exceeds ticket capacity/i);
  has(/UPDATE public\.sales_quote_version SET status='converted'/i);
  has(/UPDATE public\.opportunity SET stage_id=won_stage\.id[\s\S]*value_minor=v\.gross_minor/i);
  has(/INSERT INTO public\.opportunity_stage_history/i);
  has(/INSERT INTO public\.opportunity_activity/i);
  // The capacity exception is raised after all candidate inserts in the same RPC
  // transaction, so a failure on any mixed line rolls back the complete sale.
  assert.ok(
    sql.indexOf("INSERT INTO public.sales_commercial_sale") <
      sql.indexOf("commercial allocation exceeds ticket capacity"),
  );
});

test('concurrent claims of the final place serialize on the compatibility lock', () => {
  // Confirmation and ordinary registration use the exact same namespaced key,
  // and the post-verify path retains deterministic (created_at,id) loser removal.
  has(/CASE WHEN candidate\.event_reference_kind='complex' THEN 'cx:' ELSE '' END[\s\S]*candidate\.event_id::text\|\|':'\|\|candidate\.ticket_type_id/i);
  has(/CASE WHEN p_event_kind='complex' THEN 'cx:' ELSE '' END[\s\S]*p_event_id::text\|\|':'\|\|p_ticket_type_id/i);
  has(/\(created_at,id\)<=\(last_created,last_id\)/i);
  has(/IF rank<=\(s->>'max'\)::integer THEN RETURN s\|\|jsonb_build_object\('ok',true/i);
});

test('capacity includes both booking tables and net unused commercial places', () => {
  has(/FROM public\.booking[\s\S]*status='confirmed'/i);
  has(/FROM public\.complex_event_booking[\s\S]*status='confirmed'/i);
  has(/greatest\(t\.remaining-t\.named-t\.reserved,0\)/i);
  has(/v_used:=v_confirmed\+v_unused/i);
  has(/CREATE OR REPLACE FUNCTION public\.check_oneoff_ticket_capacity/i);
  has(/CREATE OR REPLACE FUNCTION public\.check_complex_event_ticket_capacity/i);
  has(/DELETE FROM public\.booking WHERE id=ANY\(p_booking_ids\)/i);
  has(/DELETE FROM public\.complex_event_booking WHERE id=ANY\(p_booking_ids\)/i);
});

test('group ticket quantities use the existing group_size on the final place', () => {
  has(/CASE WHEN is_group_ticket THEN COALESCE\(group_size,1\) ELSE 1 END/i);
  has(/places:=candidate\.quantity\*candidate\.component_quantity\*multiplier/i);
  has(/places<>trunc\(places\)/i);
});

test('lifecycle movements are immutable, derived, bounded, and idempotent', () => {
  for (const kind of ['allocated', 'named', 'reserved', 'released', 'cancelled']) {
    has(new RegExp(`movement_kind='${kind}'`, 'i'));
  }
  has(/AS remaining/i);
  has(/Commercial allocation records are append-only/i);
  has(/release cannot reduce allocation below named and reserved places/i);
  has(/release_sales_commercial_allocation/i);
  has(/cancel_sales_commercial_allocation/i);
  has(/reconcile_sales_commercial_booking/i);
  has(/UNIQUE \(tenant_id,allocation_id,idempotency_key\)/i);
});

test('event, ticket, and deleted booking snapshots remain independent of sources', () => {
  has(/event_snapshot jsonb NOT NULL/i);
  has(/ticket_snapshot jsonb NOT NULL/i);
  has(/booking_snapshot jsonb NOT NULL/i);
  has(/SELECT to_jsonb\(b\) INTO snap FROM public\.booking/i);
  has(/SELECT to_jsonb\(b\) INTO snap FROM public\.complex_event_booking/i);
  has(/COALESCE\(v\.event_snapshot,'\{\}'::jsonb\),COALESCE\(candidate\.ticket_snapshot,'\{\}'::jsonb\)/i);
  // No mutable event, ticket, or booking foreign key is present in allocation facts.
  assert.doesNotMatch(
    sql,
    /FOREIGN KEY \([^)]*(event_id|ticket_type_id|booking_id)[^)]*\)/i,
  );
});

test('commercial SECURITY DEFINER API is fail closed to browser roles', () => {
  for (const fn of [
    'confirm_sales_quote_sale',
    'release_sales_commercial_allocation',
    'cancel_sales_commercial_allocation',
    'reconcile_sales_commercial_booking',
  ]) {
    has(new RegExp(`FUNCTION public\\.${fn}[\\s\\S]*?SECURITY DEFINER`, 'i'));
    has(new RegExp(`public\\.${fn}\\([^;]*[\\s\\S]*?FROM PUBLIC,anon,authenticated`, 'i'));
  }
  has(/auth\.role\(\)<>'service_role'/i);
  has(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/i);
});

test('commercial allocation functions work against isolated PostgreSQL', {
  timeout: 30_000,
}, async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psqlBin = executable('psql');
  if (!initdb || !pgCtl || !psqlBin) {
    t.skip('PostgreSQL command-line tools are unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'sales-commercial-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  spawnSync('mkdir', ['-p', socket]);
  const args = ['-h', socket, '-p', '55441', '-U', 'postgres', '-d', 'postgres',
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q'];
  let started = false;
  const tenant = '00000000-0000-4000-8000-000000000001';
  const actor = '10000000-0000-4000-8000-000000000001';
  const simpleEvent = '20000000-0000-4000-8000-000000000001';
  const complexEvent = '20000000-0000-4000-8000-000000000002';
  const simpleProduct = '30000000-0000-4000-8000-000000000001';
  const complexProduct = '30000000-0000-4000-8000-000000000002';
  const overflowProduct = '30000000-0000-4000-8000-000000000003';

  try {
    psql(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    psql(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${socket} -c listen_addresses= -p 55441`, '-w', 'start']);
    started = true;
    psql(psqlBin, args, `
      CREATE EXTENSION pgcrypto;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE organization(id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE opportunity_stage(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, position integer NOT NULL,
        is_active boolean NOT NULL, is_won boolean NOT NULL);
      CREATE TABLE opportunity(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
        stage_id uuid, loss_reason_id uuid, value_minor bigint, currency text, version integer NOT NULL DEFAULT 1, updated_at timestamptz,
        UNIQUE(tenant_id,id));
      CREATE TABLE event(id uuid PRIMARY KEY, tenant_id uuid, pricing_config jsonb);
      CREATE TABLE complex_event(id uuid PRIMARY KEY);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY, tenant_id uuid, complex_event_id uuid,
        is_group_ticket boolean NOT NULL DEFAULT false, group_size integer, available_count integer,
        is_unlimited_tickets boolean NOT NULL DEFAULT true);
       CREATE TABLE booking(id uuid PRIMARY KEY, tenant_id uuid, event_id uuid, ticket_class_id text, status text, created_at timestamptz);
       CREATE TABLE complex_event_booking(id uuid PRIMARY KEY, tenant_id uuid, event_id uuid, ticket_class_id text, status text, created_at timestamptz);
      CREATE TABLE sales_catalogue_product(id uuid PRIMARY KEY, tenant_id uuid, event_reference_kind text,
        event_id uuid, ticket_type_id text, UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, opportunity_id uuid,
        current_version integer, row_version integer, updated_by text, updated_at timestamptz, UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_version(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, quote_id uuid,
        version_number integer, status text, event_snapshot jsonb, gross_minor bigint, currency text,
        updated_at timestamptz, UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_line(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, quote_version_id uuid,
        product_id uuid, quantity numeric, catalogue_snapshot jsonb, UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_bundle_component(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, quote_line_id uuid,
        product_id uuid, quantity integer, product_snapshot jsonb, UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_status_history(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,quote_id uuid,
        quote_version_id uuid,from_status text,to_status text,actor_id text,actor_type text,note text);
      CREATE TABLE opportunity_stage_history(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,opportunity_id uuid,
        from_stage_id uuid,to_stage_id uuid,actor_kind text,actor_id uuid,note text);
      CREATE TABLE opportunity_activity(id uuid DEFAULT gen_random_uuid(),tenant_id uuid,opportunity_id uuid,
        organization_id uuid,actor_kind text,actor_id uuid,action text,summary text,metadata jsonb);
      INSERT INTO tenant VALUES('${tenant}');
      INSERT INTO organization VALUES('40000000-0000-4000-8000-000000000001','${tenant}');
      INSERT INTO opportunity_stage VALUES
        ('51000000-0000-4000-8000-000000000001','${tenant}',0,true,false),
        ('51000000-0000-4000-8000-000000000002','${tenant}',1,true,true);
      INSERT INTO opportunity VALUES('50000000-0000-4000-8000-000000000001','${tenant}',
        '40000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001',
        NULL,NULL,'GBP',1,now());
      INSERT INTO event VALUES('${simpleEvent}','${tenant}',
        '{"ticket_classes":[{"id":"S","available_count":1}]}');
      INSERT INTO complex_event VALUES('${complexEvent}');
      INSERT INTO complex_event_ticket_class VALUES
        ('60000000-0000-4000-8000-000000000001','${tenant}','${complexEvent}',true,3,10,false);
      INSERT INTO sales_catalogue_product VALUES
        ('${simpleProduct}','${tenant}','simple','${simpleEvent}','S'),
        ('${complexProduct}','${tenant}','complex','${complexEvent}','60000000-0000-4000-8000-000000000001'),
        ('${overflowProduct}','${tenant}','simple','${simpleEvent}','S');
    `);
    psql(psqlBin, [...args, '-f', migrationPath]);
    // Apply the quote-delivery migration to the same isolated PostgreSQL
    // instance: this ensures its SECURITY DEFINER wrapper composes with the
    // real allocation RPC rather than merely passing a textual assertion.
    psql(psqlBin, [...args, '-f', deliveryMigrationPath]);

    // q1/q2 each claim the same single simple-event place concurrently.
    psql(psqlBin, args, `
      INSERT INTO sales_quote(id,tenant_id,opportunity_id,current_version,row_version) VALUES
       ('70000000-0000-4000-8000-000000000001','${tenant}',NULL,1,1),
       ('70000000-0000-4000-8000-000000000002','${tenant}',NULL,1,1),
       ('70000000-0000-4000-8000-000000000003','${tenant}',NULL,1,1),
       ('70000000-0000-4000-8000-000000000004','${tenant}',NULL,1,1),
       ('70000000-0000-4000-8000-000000000005','${tenant}','50000000-0000-4000-8000-000000000001',1,1);
      INSERT INTO sales_quote_version(id,tenant_id,quote_id,version_number,status,event_snapshot,gross_minor,currency) VALUES
       ('71000000-0000-4000-8000-000000000001','${tenant}','70000000-0000-4000-8000-000000000001',1,'accepted','{"event":"old"}',100,'GBP'),
       ('71000000-0000-4000-8000-000000000002','${tenant}','70000000-0000-4000-8000-000000000002',1,'accepted','{}',100,'GBP'),
       ('71000000-0000-4000-8000-000000000003','${tenant}','70000000-0000-4000-8000-000000000003',1,'accepted','{"event":"complex-old"}',100,'GBP'),
       ('71000000-0000-4000-8000-000000000004','${tenant}','70000000-0000-4000-8000-000000000004',1,'accepted','{}',100,'GBP'),
       ('71000000-0000-4000-8000-000000000005','${tenant}','70000000-0000-4000-8000-000000000005',1,'accepted','{}',100,'GBP');
      INSERT INTO sales_quote_line(id,tenant_id,quote_version_id,product_id,quantity,catalogue_snapshot) VALUES
       ('72000000-0000-4000-8000-000000000001','${tenant}','71000000-0000-4000-8000-000000000001','${simpleProduct}',1,'{"ticket":"first"}'),
       ('72000000-0000-4000-8000-000000000002','${tenant}','71000000-0000-4000-8000-000000000002','${simpleProduct}',1,'{"ticket":"second"}'),
       ('72000000-0000-4000-8000-000000000003','${tenant}','71000000-0000-4000-8000-000000000003','${complexProduct}',2,'{"ticket":"group-old"}'),
       ('72000000-0000-4000-8000-000000000004','${tenant}','71000000-0000-4000-8000-000000000004','${complexProduct}',1,'{}'),
        ('72000000-0000-4000-8000-000000000005','${tenant}','71000000-0000-4000-8000-000000000005','${complexProduct}',1,'{}'),
       ('72000000-0000-4000-8000-000000000006','${tenant}','71000000-0000-4000-8000-000000000004','${overflowProduct}',1,'{}');
    `);
    const concurrent = await Promise.all([
      psqlAsync(psqlBin, [...args, '-t', '-A'], `BEGIN; SELECT confirm_sales_quote_sale('${tenant}','70000000-0000-4000-8000-000000000001',1,'race-1','member','${actor}'); SELECT pg_sleep(.2); COMMIT;`),
      psqlAsync(psqlBin, [...args, '-t', '-A'], `BEGIN; SELECT confirm_sales_quote_sale('${tenant}','70000000-0000-4000-8000-000000000002',1,'race-2','member','${actor}'); COMMIT;`),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 0).length, 1,
      concurrent.map((result) => result.stderr).join('\n'));
    const winner = concurrent[0].status === 0
      ? ['70000000-0000-4000-8000-000000000001', 'race-1']
      : ['70000000-0000-4000-8000-000000000002', 'race-2'];
    const retry = psql(psqlBin, [...args, '-t', '-A'], `SELECT confirm_sales_quote_sale('${tenant}','${winner[0]}',1,'${winner[1]}','member','${actor}') ->> 'idempotent';`);
    assert.equal(retry, 'true');
    const simpleAllocation = psql(psqlBin, [...args, '-t', '-A'], `SELECT allocation_id FROM sales_commercial_allocation_totals WHERE event_reference_kind='simple';`);
    psql(psqlBin, args, `INSERT INTO booking(id,tenant_id,event_id,ticket_class_id,status,created_at) VALUES('81000000-0000-4000-8000-000000000001','${tenant}','${simpleEvent}','S','confirmed',now()); SELECT reconcile_sales_commercial_booking('${tenant}','${simpleAllocation}','simple','81000000-0000-4000-8000-000000000001','named',1,'simple-named','member','${actor}');`);
    const cancellationRace = await Promise.all([
      psqlAsync(psqlBin, [...args, '-t', '-A'], `BEGIN; SELECT cancel_event_booking_with_allocation('${tenant}','simple','81000000-0000-4000-8000-000000000001','booking-cancelled:81000000-0000-4000-8000-000000000001','system','81000000-0000-4000-8000-000000000001'); SELECT pg_sleep(.2); COMMIT;`),
      new Promise((resolve) => setTimeout(() => resolve(psqlAsync(psqlBin, [...args, '-t', '-A'], `SELECT check_oneoff_ticket_capacity('${simpleEvent}','S',1,NULL)->>'ok';`)), 40)).then((result) => result),
    ]);
    assert.equal(cancellationRace[0].status, 0, cancellationRace[0].stderr);
    assert.equal(cancellationRace[1].status, 0, cancellationRace[1].stderr);
    assert.match(cancellationRace[1].stdout, /false/);
    const atomicCancellation = psql(psqlBin, [...args, '-t', '-A'], `SELECT b.status || ':' || t.named || ':' || (t.remaining-t.named-t.reserved) FROM booking b CROSS JOIN sales_commercial_allocation_totals t WHERE b.id='81000000-0000-4000-8000-000000000001' AND t.allocation_id='${simpleAllocation}';`);
    assert.equal(atomicCancellation, 'cancelled:0:1');

    // The complex group ticket yields 2 tickets * existing group_size 3 = 6 places.
    psql(psqlBin, args, `SELECT confirm_sales_quote_sale('${tenant}','70000000-0000-4000-8000-000000000003',1,'group','member','${actor}');`);
    const group = psql(psqlBin, [...args, '-t', '-A'], `SELECT allocated || ':' || remaining FROM sales_commercial_allocation_totals WHERE ticket_type_id='60000000-0000-4000-8000-000000000001';`);
    assert.equal(group, '6:6');
    psql(psqlBin, args, `SELECT confirm_sales_quote_sale('${tenant}','70000000-0000-4000-8000-000000000005',1,'won-sale','member','${actor}');`);
    const opportunityState = psql(psqlBin, [...args, '-t', '-A'], `SELECT o.stage_id || ':' || o.version || ':' || (SELECT count(*) FROM opportunity_stage_history h WHERE h.opportunity_id=o.id) || ':' || (SELECT count(*) FROM opportunity_activity a WHERE a.opportunity_id=o.id AND a.action='sale.confirmed') FROM opportunity o WHERE o.id='50000000-0000-4000-8000-000000000001';`);
    assert.equal(opportunityState, '51000000-0000-4000-8000-000000000002:2:1:1');
    const secondComplexAllocation = psql(psqlBin, [...args, '-t', '-A'], `SELECT allocation_id FROM sales_commercial_allocation_totals WHERE ticket_type_id='60000000-0000-4000-8000-000000000001' AND allocated=3;`);
    psql(psqlBin, args, `INSERT INTO complex_event_booking VALUES('80000000-0000-4000-8000-000000000002','${tenant}','${complexEvent}','60000000-0000-4000-8000-000000000001','confirmed',now());`);
    const reconcileCancelRace = await Promise.all([
      psqlAsync(psqlBin, [...args, '-t', '-A'], `BEGIN; SELECT reconcile_sales_commercial_booking('${tenant}','${secondComplexAllocation}','complex','80000000-0000-4000-8000-000000000002','named',1,'race-named','member','${actor}'); SELECT pg_sleep(.2); COMMIT;`),
      new Promise((resolve) => setTimeout(() => resolve(psqlAsync(psqlBin, [...args, '-t', '-A'], `SELECT cancel_event_booking_with_allocation('${tenant}','complex','80000000-0000-4000-8000-000000000002','booking-cancelled:80000000-0000-4000-8000-000000000002','system','80000000-0000-4000-8000-000000000002');`)), 40)).then((result) => result),
    ]);
    assert.equal(reconcileCancelRace[0].status, 0, reconcileCancelRace[0].stderr);
    assert.equal(reconcileCancelRace[1].status, 0, reconcileCancelRace[1].stderr);
    const raceState = psql(psqlBin, [...args, '-t', '-A'], `SELECT b.status || ':' || t.named || ':' || (t.remaining-t.named-t.reserved) FROM complex_event_booking b CROSS JOIN sales_commercial_allocation_totals t WHERE b.id='80000000-0000-4000-8000-000000000002' AND t.allocation_id='${secondComplexAllocation}';`);
    assert.equal(raceState, 'cancelled:0:3');
    const repeatedCancellation = psql(psqlBin, [...args, '-t', '-A'], `SELECT cancel_event_booking_with_allocation('${tenant}','complex','80000000-0000-4000-8000-000000000002','booking-cancelled:80000000-0000-4000-8000-000000000002','system','80000000-0000-4000-8000-000000000002')->>'alreadyCancelled';`);
    assert.equal(repeatedCancellation, 'true');

    // A mixed sale attempts to allocate a sixth complex place and an already-full simple place.
    // It must roll back both candidate allocations and the sale boundary.
    const mixed = spawnSync(psqlBin, args, { input: `SELECT confirm_sales_quote_sale('${tenant}','70000000-0000-4000-8000-000000000004',1,'mixed','member','${actor}');`, encoding: 'utf8' });
    assert.notEqual(mixed.status, 0);
    const rolledBack = psql(psqlBin, [...args, '-t', '-A'], `SELECT (SELECT count(*) FROM sales_commercial_sale WHERE idempotency_key='mixed') || ':' || (SELECT count(*) FROM sales_commercial_allocation a JOIN sales_commercial_sale s ON s.id=a.sale_id WHERE s.idempotency_key='mixed');`);
    assert.equal(rolledBack, '0:0');

    // Reconcile a named booking, enforce release/cancel floor, then prove wrappers count unused allocation.
    psql(psqlBin, args, `INSERT INTO complex_event_booking VALUES('80000000-0000-4000-8000-000000000001','${tenant}','${complexEvent}','60000000-0000-4000-8000-000000000001','confirmed',now());`);
    const allocation = psql(psqlBin, [...args, '-t', '-A'], `SELECT allocation_id FROM sales_commercial_allocation_totals WHERE ticket_type_id='60000000-0000-4000-8000-000000000001' AND allocated=6;`);
    const tooManyNamed = spawnSync(psqlBin, args, { input: `SELECT reconcile_sales_commercial_booking('${tenant}','${allocation}','complex','80000000-0000-4000-8000-000000000001','named',2,'unsafe-named','member','${actor}');`, encoding: 'utf8' });
    assert.notEqual(tooManyNamed.status, 0);
    const wrongKind = spawnSync(psqlBin, args, { input: `SELECT reconcile_sales_commercial_booking('${tenant}','${allocation}','simple','80000000-0000-4000-8000-000000000001','named',1,'wrong-kind','member','${actor}');`, encoding: 'utf8' });
    assert.notEqual(wrongKind.status, 0);
    psql(psqlBin, args, `SELECT reconcile_sales_commercial_booking('${tenant}','${allocation}','complex','80000000-0000-4000-8000-000000000001','named',1,'named-1','member','${actor}');`);
    const floor = spawnSync(psqlBin, args, { input: `SELECT release_sales_commercial_allocation('${tenant}','${allocation}',6,'too-far','floor','member','${actor}');`, encoding: 'utf8' });
    assert.notEqual(floor.status, 0);
    psql(psqlBin, args, `SELECT release_sales_commercial_allocation('${tenant}','${allocation}',5,'release-ok','release','member','${actor}');`);
    const cancelFloor = spawnSync(psqlBin, args, { input: `SELECT cancel_sales_commercial_allocation('${tenant}','${allocation}',1,'cancel-too-far','floor','member','${actor}');`, encoding: 'utf8' });
    assert.notEqual(cancelFloor.status, 0);
    const simpleCheck = psql(psqlBin, [...args, '-t', '-A'], `SELECT check_oneoff_ticket_capacity('${simpleEvent}','S',1,NULL)->>'ok';`);
    assert.equal(simpleCheck, 'false');
    const complexCheck = psql(psqlBin, [...args, '-t', '-A'], `SELECT check_complex_event_ticket_capacity('${complexEvent}','60000000-0000-4000-8000-000000000001',4,NULL)->>'ok';`);
    assert.equal(complexCheck, 'true');
    psql(psqlBin, args, `UPDATE complex_event_booking SET status='cancelled' WHERE id='80000000-0000-4000-8000-000000000001'; SELECT unreconcile_sales_commercial_booking('${tenant}','complex','80000000-0000-4000-8000-000000000001','booking-cancelled:80000000-0000-4000-8000-000000000001','system','80000000-0000-4000-8000-000000000001');`);
    const afterCancellation = psql(psqlBin, [...args, '-t', '-A'], `SELECT named || ':' || (remaining-named-reserved) FROM sales_commercial_allocation_totals WHERE allocation_id='${allocation}';`);
    assert.equal(afterCancellation, '0:1');

    // Source mutation/removal has no FK path into allocation facts; quote snapshots remain historic.
    psql(psqlBin, args, `UPDATE complex_event_ticket_class SET group_size=99 WHERE id='60000000-0000-4000-8000-000000000001'; DELETE FROM sales_catalogue_product WHERE id='${complexProduct}'; DELETE FROM complex_event_ticket_class WHERE id='60000000-0000-4000-8000-000000000001';`);
    const snapshots = psql(psqlBin, [...args, '-t', '-A'], `SELECT (event_snapshot->>'event') || ':' || (ticket_snapshot->>'ticket') || ':' || allocated_places FROM sales_commercial_allocation WHERE id='${allocation}';`);
    assert.equal(snapshots, 'complex-old:group-old:6');
  } finally {
    if (started) psql(pgCtl, ['-D', data, '-m', 'fast', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});