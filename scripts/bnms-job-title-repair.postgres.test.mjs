import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { TENANT, hash } from './bnms-job-title-repair-core.mjs';
import { liveSchema, executeRepair } from './bnms-job-title-repair-db.mjs';

test('isolated PostgreSQL: atomic note/title repair, rollback, replay, stale checks and update-only corrections', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-title-pg-')), data = path.join(root, 'data'), socket = path.join(root, 'socket');
  mkdirSync(socket);
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const db = new pg.Client({ host: socket, port: 55461, user: 'postgres', database: 'postgres' });
  let started = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'pg.log'), '-o', `-F -k ${socket} -c listen_addresses= -p 55461`, '-w', 'start']); started = true;
    await db.connect();
    await db.query(`create table tenant(id uuid primary key,name text);
      create table member(id uuid primary key,tenant_id uuid,job_title text,updated_at timestamptz default now(),survey_invitation_revision int default 1,protected text);
      create table member_note(id text primary key,target_member_id text,author_member_id text,content text,attachments jsonb);
      create table member_group(id uuid,tenant_id uuid,automatic_membership_enabled boolean,automatic_membership_filter_groups jsonb);
      create function fixture_update() returns trigger language plpgsql as $$begin NEW.updated_at=now(); NEW.survey_invitation_revision=OLD.survey_invitation_revision+1; return NEW; end;$$;
      create trigger fixture_update before update on member for each row execute function fixture_update();`);
    const id = '00000000-0000-4000-8000-000000000001';
    await db.query('insert into tenant values($1,$2)', [TENANT, 'BNMS']);
    await db.query("insert into member(id,tenant_id,job_title,protected) values($1,$2,'Application statement','untouched')", [id, TENANT]);
    const read = async () => (await db.query('select to_jsonb(m) record from member m where id=$1', [id])).rows[0].record;
    const before = await read(), schemaHash = hash(await liveSchema(db));
    const item = { id, tenant_id: TENANT, before, title: null, note: { id: 'deterministic', target_member_id: id, author_member_id: null, content: 'Automated preservation\nApplication statement' } };
    assert.equal((await executeRepair(db, [item], schemaHash)).pending, 1);
    await assert.rejects(executeRepair(db, [item], schemaHash, { apply: true, journal: stage => { if (stage === 'precommit') throw Error('failure before commit'); } }));
    assert.deepEqual(await read(), before);
    assert.equal((await db.query('select count(*)::int n from member_note')).rows[0].n, 0);
    assert.equal((await executeRepair(db, [item], schemaHash, { apply: true })).changed, 1);
    assert.equal((await executeRepair(db, [item], schemaHash, { apply: true })).changed, 0);
    assert.equal((await db.query('select count(*)::int n from member_note')).rows[0].n, 1);
    const corrected = { id, tenant_id: TENANT, before: await read(), title: 'Clinical Scientist' };
    await db.query("update member set protected='concurrent change' where id=$1", [id]);
    await assert.rejects(executeRepair(db, [corrected], schemaHash, { apply: true }), /Stale/);
    corrected.before = await read();
    assert.equal((await executeRepair(db, [corrected], schemaHash, { apply: true })).changed, 1);
    assert.equal((await read()).job_title, 'Clinical Scientist');
    assert.equal((await db.query('select count(*)::int n from member')).rows[0].n, 1);
    await assert.rejects(executeRepair(db, [{ ...corrected, id: '00000000-0000-4000-8000-000000000002', before: { ...corrected.before, id: '00000000-0000-4000-8000-000000000002' } }], schemaHash, { apply: true }), /Unknown/);
  } finally {
    await db.end().catch(() => {});
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});
