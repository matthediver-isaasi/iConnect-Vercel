import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('ticket event discovery: global pages, future instants, draft hydration, literal search and service-only isolation', () => {
  const root = mkdtempSync(join(tmpdir(), 'sales-ticket-options-'));
  const data = join(root, 'db'), socket = join(root, 'socket');
  mkdirSync(socket);
  const run = (cmd, args, input, ok = true) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    if (ok) assert.equal(r.status, 0, r.stderr);
    else assert.notEqual(r.status, 0, 'Expected permission or validation rejection');
    return r.stdout.trim();
  };
  const sql = (query, ok = true) => run('psql', ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-qXAt', '-v', 'ON_ERROR_STOP=1'], query, ok);
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tenant = id(1), other = id(2);
  const read = (search = '', page = 1, selected = null, kind = null, owner = tenant) => JSON.parse(sql(
    `SET ROLE service_role; SELECT sales_ticket_event_options('${owner}', '${search}', ${page}, ${selected ? `'${selected}'` : 'null'}, ${kind ? `'${kind}'` : 'null'});`));
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(root, 'log'), '-o', `-F -k ${socket} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE event(id uuid PRIMARY KEY, tenant_id uuid, title text, start_date timestamptz,
        end_date timestamptz, waiting_list_enabled boolean, pricing_config jsonb, status text);
      CREATE TABLE complex_event(LIKE event INCLUDING ALL);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY, tenant_id uuid, complex_event_id uuid,
        name text, is_group_ticket boolean, group_size integer);
      INSERT INTO event SELECT ('00000000-0000-4000-8000-'||lpad((1000+n)::text,12,'0'))::uuid,
        '${tenant}', 'Event '||lpad(n::text,4,'0'), now()+interval '30 days',null,false,
        '{"ticket_classes":[{"id":"standard","name":"Standard"},{"id":"group","name":"Group","is_group_ticket":true,"group_size":4}]}', 'draft'
        FROM generate_series(1,1100,2) n;
      INSERT INTO complex_event SELECT ('00000000-0000-4000-8000-'||lpad((1000+n)::text,12,'0'))::uuid,
        '${tenant}', 'Event '||lpad(n::text,4,'0'), now()+interval '30 days',null,false,null,'draft'
        FROM generate_series(2,1100,2) n;
      INSERT INTO complex_event_ticket_class SELECT gen_random_uuid(),tenant_id,id,'Standard',false,null FROM complex_event;
      INSERT INTO event VALUES
        ('${id(10)}','${tenant}','Past',now()-interval '1 second',now()+interval '3 days',false,'{"ticket_classes":[{"id":"t"}]}','published'),
        ('${id(11)}','${tenant}','Undated',null,null,false,'{"ticket_classes":[{"id":"t"}]}','draft'),
        ('${id(12)}','${tenant}','Waiting',now()+interval '3 days',null,true,'{"ticket_classes":[{"id":"t"}]}','draft'),
        ('${id(13)}','${tenant}','No tickets',now()+interval '3 days',null,false,'{}','draft'),
        ('${id(14)}','${other}','Other tenant',now()+interval '3 days',null,false,'{"ticket_classes":[{"id":"t"}]}','draft'),
        ('${id(15)}','${tenant}','Literal .*%_',now()+interval '3 days',null,false,'{"ticket_classes":[{"id":"t"}]}','draft');`);
    sql(readFileSync(new URL('../../supabase/migrations/202701240001_sales_ticket_event_discovery.sql', import.meta.url), 'utf8'));
    for (const invalid of ['invalid', '2027-02-30T12:00:00Z', '2027-10-31', '2027-10-31T01:30:00']) {
      assert.equal(sql(`SELECT sales_ticket_known_instant('${invalid}') IS NULL;`), 't');
    }
    assert.equal(sql(`SELECT sales_ticket_known_instant('2027-10-31T01:30:00+01:00') =
      sales_ticket_known_instant('2027-10-31T00:30:00Z');`), 't');
    const first = read('Event');
    assert.equal(first.items.length, 25);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.items.map(e => e.name), Array.from({ length: 25 }, (_, i) => `Event ${String(i + 1).padStart(4, '0')}`));
    assert.deepEqual(read('Event', 2).items.map(e => e.name), Array.from({ length: 25 }, (_, i) => `Event ${String(i + 26).padStart(4, '0')}`));
    assert.equal(read('Event', 41).items[0].name, 'Event 1001', 'no PostgREST 1000-row truncation');
    assert.equal(read('Event', 44).hasMore, false);
    assert.deepEqual(read('Event', 45).items, []);
    assert.equal(first.items[0].ticketOptions[1].delegateCapacity, 4);
    assert.equal(first.items[1].kind, 'complex');
    assert.equal(read('.*%_').items[0].id, id(15), 'wildcards are literal text');
    for (const n of [10, 11, 12, 13]) {
      const saved = read('', 1, id(n), 'simple').items[0];
      assert.equal(saved.eligible, false);
      assert.ok(saved.unavailableReason);
      assert.deepEqual(read(saved.name).items, [], 'ineligible event cannot be newly selected');
    }
    assert.deepEqual(read('', 1, id(14), 'simple').items, [], 'selected hydration remains tenant-scoped');
    assert.equal(read('', 1, id(14), 'simple', other).items[0].eligible, true);
    assert.deepEqual(read('', 1, id(1001), 'complex').items, [], 'kind is part of selected identity');
    for (const role of ['anon', 'authenticated']) sql(`SET ROLE ${role}; SELECT sales_ticket_event_options('${tenant}');`, false);
    sql(`SET ROLE service_role; SELECT sales_ticket_event_options('${tenant}','',0);`, false);
    // Same name across both sources remains stable at the page boundary.
    sql(`UPDATE event SET title='Tie' WHERE id='${id(1001)}';
      UPDATE complex_event SET title='Tie' WHERE id='${id(1002)}';`);
    assert.deepEqual(read('Tie').items.map(e => e.kind), ['complex', 'simple']);
    // The known start instant, not its printed offset or future end, is authoritative.
    sql(`UPDATE event SET start_date='2000-01-01T01:00:00+01:00' WHERE id='${id(1001)}';`);
    assert.equal(read('Tie').items.length, 1);
    sql(`ALTER TABLE event ALTER COLUMN start_date TYPE text USING start_date::text;
      UPDATE event SET start_date='2030-01-01T00:00:00Z' WHERE id='${id(1001)}';
      UPDATE event SET start_date='not a date' WHERE id='${id(10)}';`);
    assert.equal(read('', 1, id(1001), 'simple').items[0].eligible, true, 'legacy text instant is supported');
    assert.equal(read('', 1, id(10), 'simple').items[0].eligible, false, 'malformed legacy dates fail closed');
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
