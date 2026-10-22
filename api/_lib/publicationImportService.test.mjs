import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
const { createPublicationImportService, signPlan, verifyPlan, permissions } = await import('./publicationImportService.js');

const tenant = '10000000-0000-0000-0000-000000000001';
const member = '20000000-0000-0000-0000-000000000001';
const role = '30000000-0000-0000-0000-000000000001';
const ctx = { isAuthenticated: true, tenantId: tenant, memberId: member };
const state = () => ({ actor: { id: member }, member: { id: member, role_id: role }, role: { id: role, excluded_features: [] },
  settings: {}, members: [], externalWriters: [], briefs: [], accessItems: [] });
const secret = 'unit-test-key';
test('signed plans reject tampering and actor/tenant substitution', () => {
  const token = signPlan({ version: 1, actor: `member:${member}`, tenant, records: [] }, secret);
  assert.equal(verifyPlan(token, secret, ctx).tenant, tenant);
  assert.throws(() => verifyPlan(`${token}x`, secret, ctx), /Invalid/);
  assert.throws(() => verifyPlan(token, secret, { ...ctx, tenantId: 'different' }), /different actor/);
  assert.throws(() => verifyPlan(token, secret, { ...ctx, memberId: 'different' }), /different actor/);
});
test('permissions fail closed and honor effective member and dynamic parent exclusions', () => {
  assert.throws(() => permissions(state(), { ...ctx, tenantMismatch: true }), /tenant/);
  assert.throws(() => permissions({ ...state(), role: null }, ctx), /role/);
  const s = state();
  s.member.member_excluded_features = ['content'];
  assert.throws(() => permissions(s, ctx), /Manage/);
  s.member.member_excluded_features = ['custom-parent'];
  s.accessItems = [{ id: 'p', item_key: 'custom-parent' }, { id: 'f', item_key: 'content.briefs.manage', parent_id: 'p' }];
  assert.throws(() => permissions(s, ctx), /Manage/);
  assert.throws(() => permissions(state(), { ...ctx, isAuthenticated: false }), /Authentication/);
  const assignDenied = state();
  assignDenied.role.excluded_features = ['content.briefs.assign'];
  assert.equal(permissions(assignDenied, ctx).canAssign, false);
});
test('unsaved settings use API defaults and parser owns status resolution; tenant mismatch never reads', async () => {
  let reads = 0;
  const db = { rpc: async () => { reads++; return { data: { ...state(), settings: null } }; } };
  const parser = {
    parsePublicationWorkbook: () => ({ sheets: ['Data'], sheetName: 'Data', records: [{ row: 2, values: { Title: 'Test', Status: '' } }] }),
    resolvePublicationRows: (records, options) => {
      assert.equal(records[0].values.Status, '');
      assert.equal(options.settings.stages[0].key, 'new');
      assert.ok(options.settings.categories.includes('General'));
      return [{ row: 2, action: 'create', errors: [], payload: { title: 'Test', status: 'new' } }];
    },
  };
  const service = createPublicationImportService({ db, parser, secret });
  await assert.rejects(service.preview({ ...ctx, tenantMismatch: true }, {}), /tenant/);
  assert.equal(reads, 0);
  assert.equal((await service.preview(ctx, { fileName: 'test.xlsx', workbook: 'eA==' })).canApply, true);
});
test('preview has no writes, changed resolution and expiry reject; durable retry survives expiry', async () => {
  let clock = 1000; let changed = false; let receipt = null;
  const calls = [];
  const db = { rpc: async (name) => {
    calls.push(name);
    return { data: name === 'publication_import_snapshot' ? state() : name === 'publication_import_result' ? receipt :
      (receipt = { created: 1, skipped: 0, failed: 0, done: true, rows: [] }) };
  } };
  const parser = { parsePublicationWorkbook: () => ({ sheets: ['Data'], sheetName: 'Data', records: [{ row: 2, values: { Title: 'Test' } }] }),
    resolvePublicationRows: () => [{ row: 2, title: 'Test', action: 'create', payload: { title: changed ? 'Changed' : 'Test' }, errors: [] }] };
  const service = createPublicationImportService({ db, parser, secret, now: () => clock });
  const preview = await service.preview(ctx, { fileName: 'test.xlsx', workbook: 'eA==' });
  assert.deepEqual(calls, ['publication_import_snapshot']);
  changed = true;
  await assert.rejects(service.apply(ctx, preview.planId), /stale/);
  changed = false; clock = 2000000;
  await assert.rejects(service.apply(ctx, preview.planId), /expired/);
  clock = 1001;
  const result = await service.apply(ctx, preview.planId);
  clock = 3000000; changed = true;
  assert.deepEqual(await service.apply(ctx, preview.planId), result);
  assert.equal(calls.filter(c => c === 'publication_import_apply').length, 1);
});

test('isolated PostgreSQL: atomic rollback, receipt replay, stale snapshots, service-only and concurrent imports', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('publication-import-');
  const conn = ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  const run = (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout.trim();
  };
  const sql = input => run('psql', conn, input);
  const literal = x => `'${JSON.stringify(x).replaceAll("'", "''")}'::jsonb`;
  const snapshot = () => JSON.parse(sql(`SELECT publication_import_snapshot('${tenant}','${member}',null)`));
  const row = (title, extra = {}) => ({ row: 2, title, action: 'create', errors: [], payload: { title, status: 'new', ...extra } });
  const call = (id, rows, snap, expires = '2099-01-01') => `SELECT publication_import_apply('${tenant}','${member}',null,'${id}','${expires}',${literal(snap)},${literal(rows)});`;
  const id = n => `40000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const fails = (query, match) => {
    const r = spawnSync('psql', conn, { input: query, encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, match);
  };
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,role_id uuid,first_name text,last_name text,email text,member_excluded_features jsonb);
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,excluded_features jsonb);
      CREATE TABLE tenant_user(id uuid,tenant_id uuid,status text,role text);
      CREATE TABLE tenant_identity(id varchar);
      CREATE TABLE tenant_membership(id uuid,identity_id varchar,tenant_id uuid,status text,role text);
      CREATE TABLE role_access_item(id uuid,item_key text,parent_id uuid,is_active boolean);
      CREATE TABLE external_writer(id uuid PRIMARY KEY,tenant_id uuid,email text,first_name text,last_name text);
      INSERT INTO tenant VALUES('${tenant}');
      INSERT INTO role VALUES('${role}','${tenant}','[]');
      INSERT INTO member(id,tenant_id,role_id) VALUES('${member}','${tenant}','${role}');
    `);
    sql(readFileSync(new URL('../../migrations/create_article_brief_tables.sql', import.meta.url), 'utf8'));
    sql(readFileSync(new URL('../../migrations/create_article_brief_settings.sql', import.meta.url), 'utf8'));
    sql(`ALTER TABLE article_brief ADD COLUMN sla text, ADD COLUMN contract text,
      ADD COLUMN writer_deadline timestamptz,ADD COLUMN editor_deadline timestamptz,
      ADD COLUMN external_writer_id uuid REFERENCES external_writer(id),ADD COLUMN contributor_type text,
      ADD COLUMN case_study_required boolean DEFAULT false,ADD COLUMN copyright_required boolean DEFAULT false;`);
    sql(readFileSync(new URL('../../supabase/migrations/20261125_publication_import.sql', import.meta.url), 'utf8'));
    // Deployment tools may retry a migration after an interrupted response.
    sql(readFileSync(new URL('../../supabase/migrations/20261125_publication_import.sql', import.meta.url), 'utf8'));
    const before = snapshot();
    fails(`SET ROLE authenticated; SELECT publication_import_snapshot('${tenant}','${member}',null);`, /permission denied/);
    sql(`UPDATE role SET excluded_features='["content.briefs.manage"]' WHERE id='${role}';`);
    fails(call(id(90), [row('Changed permission')], before), /stale/);
    sql(`UPDATE role SET excluded_features='[]' WHERE id='${role}';`);
    sql(`INSERT INTO article_brief_settings(tenant_id) VALUES('${tenant}');`);
    fails(call(id(91), [row('Changed settings')], before), /stale/);
    sql(`DELETE FROM article_brief_settings WHERE tenant_id='${tenant}';`);
    fails(call(id(1), [row('First'), row('Broken', { external_writer_id: id(999) })], before), /foreign key/);
    assert.equal(sql('SELECT count(*) FROM article_brief;'), '0');
    assert.equal(sql('SELECT count(*) FROM publication_import_receipt;'), '0');
    const first = JSON.parse(sql(call(id(2), [row('First')], before)));
    assert.equal(first.created, 1);
    assert.deepEqual(JSON.parse(sql(call(id(2), [row('First')], before, '2000-01-01'))), first);
    assert.equal(sql('SELECT count(*) FROM article_brief_activity;'), '1');
    fails(call(id(3), [row('Second')], before), /stale/);
    const updated = snapshot();
    fails(call(id(4), [row('First', { notes: 'Conflict' })], updated), /Conflicting/);
    const skipped = JSON.parse(sql(call(id(5), [row('First')], updated)));
    assert.equal(skipped.skipped, 1);
    const normalizedSkip = JSON.parse(sql(call(id(55), [row('  FIRST  ')], snapshot())));
    assert.equal(normalizedSkip.skipped, 1);
    assert.equal(sql("SELECT title FROM article_brief WHERE title='First';"), 'First');
    const fresh = snapshot();
    const concurrent = query => new Promise(resolve => {
      const child = spawn('psql', conn); let out = ''; let err = '';
      child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
      child.on('close', code => resolve({ code, out, err })); child.stdin.end(query);
    });
    const query = call(id(6), [row('Concurrent')], fresh);
    const results = await Promise.all([concurrent(query), concurrent(query)]);
    assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
    assert.deepEqual(JSON.parse(results[0].out), JSON.parse(results[1].out));
    assert.equal(sql("SELECT count(*) FROM article_brief WHERE title='Concurrent';"), '1');
    // A manual writer holds the ordinary ROW EXCLUSIVE lock. Apply waits and then
    // rejects its pre-insert snapshot, never inserting a conflicting duplicate.
    const snap = snapshot();
    const manual = concurrent(`BEGIN; INSERT INTO article_brief(title,tenant_id) VALUES('Manual','${tenant}'); SELECT pg_sleep(0.5); COMMIT;`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const blocked = await concurrent(call(id(7), [row('Manual')], snap));
    await manual;
    assert.notEqual(blocked.code, 0); assert.match(blocked.err, /stale/);
    assert.equal(sql("SELECT count(*) FROM article_brief WHERE title='Manual';"), '1');
    // Exercise the actual XLSX parser, service and SECURITY DEFINER RPCs together.
    // The adapter only targets this harness socket and invokes every RPC as the
    // production service role, not the fixture owner.
    const parser = await import('./publicationWorkbook.js');
    const { default: XLSX } = await import('xlsx');
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const rpcNames = new Set(['publication_import_snapshot', 'publication_import_result', 'publication_import_apply']);
    const rpcArgs = new Set(['p_tenant', 'p_member', 'p_tenant_user', 'p_plan', 'p_expires', 'p_snapshot', 'p_rows']);
    const db = { rpc: async (name, args) => {
      assert.ok(rpcNames.has(name));
      const encoded = Object.entries(args).map(([key, value]) => {
        assert.ok(rpcArgs.has(key));
        return `${key} => ${value === null ? 'NULL' : typeof value === 'object' ? literal(value) : quote(value)}`;
      }).join(',');
      const r = spawnSync('psql', conn, {
        input: `SET ROLE service_role; SELECT public.${name}(${encoded});`, encoding: 'utf8',
      });
      return r.status === 0 ? { data: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null }
        : { error: { message: r.stderr } };
    } };
    const service = createPublicationImportService({ db, parser, secret });
    const template = await service.template(ctx);
    const workbook = rows => {
      const wb = XLSX.read(template, { type: 'buffer' });
      XLSX.utils.sheet_add_aoa(wb.Sheets.Publications,
        rows.map(r => parser.PUBLICATION_HEADERS.map(header => r[header] ?? '')), { origin: 'A2' });
      return { fileName: 'publications.xlsx', workbook: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }).toString('base64') };
    };
    // Unified identities use varchar IDs and need not have a legacy tenant_user.
    // Test both UUID-shaped and non-UUID IDs so an accidental UUID RPC parameter
    // cannot pass simply because the fixture happens to contain UUID text.
    for (const identity of [id(800), 'synthetic-unified-owner']) {
      sql(`INSERT INTO tenant_identity(id) VALUES('${identity}');
        INSERT INTO tenant_membership VALUES(gen_random_uuid(),'${identity}','${tenant}','active','owner');`);
      const ownerContext = { isAuthenticated: true, tenantId: tenant, tenantUserId: identity };
      assert.equal(sql(`SELECT count(*) FROM tenant_user WHERE id::text='${identity}';`), '0');
      assert.ok(Buffer.isBuffer(await service.template(ownerContext)));
      const ownerPreview = await service.preview(ownerContext, workbook([{ Title: `Owner ${identity}` }]));
      assert.equal(ownerPreview.canApply, true);
      const ownerResult = await service.apply(ownerContext, ownerPreview.planId);
      assert.equal(ownerResult.created, 1);
      assert.deepEqual(await service.apply(ownerContext, ownerPreview.planId), ownerResult);
      assert.equal(sql(`SELECT actor_key FROM publication_import_receipt
        WHERE actor_key='tenant_user:${identity}';`), `tenant_user:${identity}`);
      sql(`UPDATE tenant_membership SET status='inactive' WHERE identity_id='${identity}';`);
      await assert.rejects(service.template(ownerContext), /actor/);
    }
    for (const size of [75, 100]) {
      const input = workbook(Array.from({ length: size }, (_, index) => ({ Title: `Bulk ${size} ${index}` })));
      const preview = await service.preview(ctx, input);
      assert.equal(preview.canApply, true);
      assert.equal(preview.rows.length, size);
      assert.ok(preview.rows.every(r => r.payload.status === 'new'));
      const applied = await service.apply(ctx, preview.planId);
      assert.equal(applied.created, size);
      assert.equal(applied.failed, 0);
      const repeated = await service.preview(ctx, input);
      assert.ok(repeated.rows.every(r => r.action === 'skip'));
      const repeatedResult = await service.apply(ctx, repeated.planId);
      assert.equal(repeatedResult.created, 0);
      assert.equal(repeatedResult.skipped, size);
    }
    const foreignTenant = id(500);
    const localExternal = id(501);
    sql(`
      INSERT INTO tenant VALUES('${foreignTenant}');
      UPDATE member SET first_name='Local',last_name='Writer',email='same@example.test' WHERE id='${member}';
      INSERT INTO member(id,tenant_id,first_name,last_name,email) VALUES
        ('${id(502)}','${foreignTenant}','Local','Writer','same@example.test'),
        ('${id(503)}','${foreignTenant}','Foreign','Only','foreign@example.test');
      INSERT INTO external_writer(id,tenant_id,email,first_name,last_name) VALUES
        ('${localExternal}','${tenant}','external@example.test','External','Writer'),
        ('${id(504)}','${foreignTenant}','external@example.test','External','Writer'),
        ('${id(505)}','${foreignTenant}','foreign-external@example.test','Foreign','Only');
    `);
    const full = {
      Category: 'General', SLA: 'Monthly', Contract: 'Contributor agreement',
      'Submission Deadline': '2026-12-03T10:00:00+02:00',
      'Writer Deadline': '2026-12-01', 'Editor Deadline': '2026-12-02T09:30:00Z',
      Status: 'In Progress', Notes: 'Source notes', 'Case Study': 'Yes',
      'Member Copyright agreement': 'Yes',
    };
    const mixedInput = workbook([
      { ...full, Title: 'Mixed Internal', Writer: 'Local Writer', Editor: 'Local Writer', 'Contributor Type': 'internal' },
      { ...full, Title: 'Mixed External', 'External Writer': 'Yes', 'External Writer email': 'external@example.test',
        'External Writer first name': 'External', 'External Writer last name': 'Writer', 'Contributor Type': 'paid' },
      { Title: 'Mixed Unassigned' },
    ]);
    const mixed = await service.preview(ctx, mixedInput);
    assert.equal(mixed.canApply, true, JSON.stringify(mixed.rows));
    assert.equal(mixed.rows[0].payload.assigned_writer_id, member);
    assert.equal(mixed.rows[1].payload.external_writer_id, localExternal);
    assert.equal((await service.apply(ctx, mixed.planId)).created, 3);
    const imported = JSON.parse(sql("SELECT jsonb_agg(to_jsonb(b) ORDER BY title) FROM article_brief b WHERE title LIKE 'Mixed %';"));
    for (const record of imported) {
      const planned = mixed.rows.find(r => r.title === record.title).payload;
      for (const [key, value] of Object.entries(planned)) {
        if (['deadline', 'writer_deadline', 'editor_deadline'].includes(key) && value !== null) {
          assert.equal(Date.parse(record[key]), Date.parse(value), key);
        } else assert.deepEqual(record[key], value, key);
      }
      assert.equal(record.created_by, member);
      assert.ok(Number.isFinite(Date.parse(record.created_at)));
      assert.ok(Number.isFinite(Date.parse(record.updated_at)));
    }
    assert.equal(Date.parse(imported[0].deadline), Date.parse('2026-12-03T08:00:00Z'));
    const foreignPreview = await service.preview(ctx, workbook([
      { Title: 'Foreign internal attempt', Writer: 'Foreign Only' },
      { Title: 'Foreign external attempt', 'External Writer': 'Yes', 'External Writer email': 'foreign-external@example.test' },
    ]));
    assert.equal(foreignPreview.canApply, false);
    assert.ok(foreignPreview.rows.every(r => r.action === 'error' && r.errors.some(e => /missing or ambiguous/.test(e))));
    assert.equal(foreignPreview.planId, null);

    // A real constraint failure on row 2 must undo row 1, its activity and receipt.
    sql("ALTER TABLE article_brief ADD CONSTRAINT reject_import_note CHECK (notes IS DISTINCT FROM 'reject-atomic');");
    const atomicInput = workbook([{ Title: 'Atomic Good' }, { Title: 'Atomic Bad', Notes: 'reject-atomic' }]);
    const atomic = await service.preview(ctx, atomicInput);
    const receiptCount = sql('SELECT count(*) FROM publication_import_receipt;');
    const activityCount = sql('SELECT count(*) FROM article_brief_activity;');
    await assert.rejects(service.apply(ctx, atomic.planId), /database operation failed/);
    assert.equal(sql("SELECT count(*) FROM article_brief WHERE title LIKE 'Atomic %';"), '0');
    assert.equal(sql('SELECT count(*) FROM publication_import_receipt;'), receiptCount);
    assert.equal(sql('SELECT count(*) FROM article_brief_activity;'), activityCount);
    const corrected = await service.preview(ctx, workbook([{ Title: 'Atomic Good' }, { Title: 'Atomic Bad', Notes: 'corrected' }]));
    assert.equal((await service.apply(ctx, corrected.planId)).created, 2);

    // Unexpected triggers must be rejected before ANY trigger, notification or
    // mutation executes; sentinel models an outbound side effect.
    sql(`CREATE TABLE send_sentinel(id integer);
      CREATE FUNCTION simulated_send() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO send_sentinel VALUES(1); RETURN NEW; END $$;
      CREATE TRIGGER simulated_send AFTER INSERT ON article_brief FOR EACH ROW EXECUTE FUNCTION simulated_send();`);
    const noSend = await service.preview(ctx, workbook([{ Title: 'No send allowed' }]));
    await assert.rejects(service.apply(ctx, noSend.planId), /database operation failed/);
    assert.equal(sql('SELECT count(*) FROM send_sentinel;'), '0');
    assert.equal(sql("SELECT count(*) FROM article_brief WHERE title='No send allowed';"), '0');
    sql('DROP TRIGGER simulated_send ON article_brief;');
    assert.equal((await service.apply(ctx, noSend.planId)).created, 1);
    sql("UPDATE article_brief SET summary='private unmapped summary';");
    assert.equal(snapshot().briefs[0].summary, undefined);
    sql(`INSERT INTO member(id,tenant_id) SELECT gen_random_uuid(),'${tenant}' FROM generate_series(1,10000);`);
    fails(`SELECT publication_import_snapshot('${tenant}','${member}',null);`, /lookup limit exceeded: members/);
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    await h.cleanup();
  }
});
