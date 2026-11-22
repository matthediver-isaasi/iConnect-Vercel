import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { DEFAULT_LIFECYCLE_POLICY } from '../../shared/memberLifecyclePolicy.mjs';

test('preparatory storage preserves member data, denies execution and fences policy/preview access', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'member-lifecycle-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  await mkdir(socket);
  const port = String(22000 + process.pid % 15000);
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false, client;
  const tenant = '11111111-1111-4111-8111-111111111111';
  const role = '22222222-2222-4222-8222-222222222222';
  const member = '33333333-3333-4333-8333-333333333333';
  const foreign = '44444444-4444-4444-8444-444444444444';
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start']);
    started = true;
    client = new pg.Client({ host: socket, port: Number(port), user: 'postgres', database: 'postgres' });
    await client.connect();
    const sql = (query, params) => client.query(query, params);
    await sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,excluded_features text[],is_active boolean DEFAULT true,is_tenant_admin boolean DEFAULT false);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text);
      CREATE TABLE role_access_item(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),item_type text,item_key text UNIQUE,label text,parent_id uuid,display_order integer,is_active boolean);
      INSERT INTO role_access_item(item_type,item_key,label) VALUES('module','crm','CRM');`);
    await sql("INSERT INTO role(id,tenant_id,excluded_features) VALUES($1,$2,ARRAY['existing.permission'])", [role, tenant]);
    await sql("INSERT INTO member VALUES($1,$2,'fixture@example.invalid')", [member, tenant]);
    const migration = await readFile(new URL('20261122_member_lifecycle_preparation.sql', import.meta.url), 'utf8');
    await sql(migration);
    assert.equal((await sql('SELECT cardinality(excluded_features) n FROM role WHERE id=$1', [role])).rows[0].n, 7);
    // Replay must not revoke an explicit grant given after first installation.
    await sql("UPDATE role SET excluded_features=array_remove(excluded_features,'crm.member-lifecycle.view') WHERE id=$1", [role]);
    await sql(migration);
    assert.equal((await sql('SELECT cardinality(excluded_features) n FROM role WHERE id=$1', [role])).rows[0].n, 6);
    await sql('INSERT INTO role(id,tenant_id) VALUES($1,$2)', [foreign, foreign]);
    assert.equal((await sql('SELECT cardinality(excluded_features) n FROM role WHERE id=$1', [foreign])).rows[0].n, 6);
    for (const actor of ['anon', 'authenticated']) {
      const privileges = (await sql(`SELECT
        has_table_privilege($1,'member_lifecycle_policy','SELECT') AS read,
        has_function_privilege($1,'save_member_lifecycle_policy(uuid,bigint,jsonb,text)','EXECUTE') AS save,
        has_function_privilege($1,'member_lifecycle_preview_page(uuid,text,bigint,uuid,uuid,jsonb,uuid,boolean)','EXECUTE') AS preview`, [actor])).rows[0];
      assert.deepEqual(privileges, { read: false, save: false, preview: false });
    }
    await sql('SET ROLE service_role');
    const policy = { ...DEFAULT_LIFECYCLE_POLICY, formerRoleId: role, guestRoleId: role };
    const save = async (revision, body = policy) => (await sql('SELECT save_member_lifecycle_policy($1,$2,$3,$4) AS saved',
      [tenant, revision, JSON.stringify(body), 'member:admin'])).rows[0].saved;
    assert.equal((await save(0)).revision, 1);
    await assert.rejects(save(0), error => error.code === 'PT409');
    await assert.rejects(save(1, { ...policy, formerRoleId: foreign }), /unavailable/);
    await assert.rejects(save(1, { ...policy, enabled: true }), /cannot enable/);
    await assert.rejects(sql('UPDATE member_lifecycle_policy SET enabled=true'), /permission denied/);
    const preview = async (previewId, cursor, items, complete, actor = 'member:admin', revision = 1) => (
      await sql('SELECT member_lifecycle_preview_page($1,$2,$3,$4,$5,$6,$7,$8) AS preview',
        [tenant, actor, revision, previewId, cursor, JSON.stringify(items), items.at(-1)?.memberId || cursor, complete])
    ).rows[0].preview;
    const first = await preview(null, null, [{ memberId: member, action: 'evidence_review', reason: 'unknown_history' }], false);
    assert.equal(first.counts.evidence_review, 1);
    await assert.rejects(preview(first.previewId, member, [], true, 'member:other'), error => error.code === 'PT409');
    await assert.rejects(preview(first.previewId, null, [], true), error => error.code === 'PT409');
    assert.equal((await preview(first.previewId, member, [], true)).complete, true);
    await assert.rejects(preview(first.previewId, member, [], true), error => error.code === 'PT409');
    await assert.rejects(preview(null, null, [{ memberId: foreign, action: 'archive', reason: 'test' }], true), /Invalid preview/);
    await save(1);
    await assert.rejects(preview(null, null, [], true), error => error.code === 'PT409');
    await sql('RESET ROLE');
    await assert.rejects(sql('UPDATE member_lifecycle_policy SET enabled=true'), /check constraint/);
    assert.equal((await sql('SELECT email FROM member WHERE id=$1', [member])).rows[0].email, 'fixture@example.invalid');
    assert.equal((await sql('SELECT count(*)::int n FROM member_lifecycle_policy_audit')).rows[0].n, 2);
    assert.equal((await sql("SELECT count(*)::int n FROM pg_class WHERE relname LIKE 'member_lifecycle_%' AND relkind='r' AND NOT relrowsecurity")).rows[0].n, 0);
  } finally {
    await client?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
