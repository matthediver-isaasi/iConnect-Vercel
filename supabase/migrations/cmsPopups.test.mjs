import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { POPUP_DEFAULT_CONFIG, POPUP_EMPTY_DESIGN } from '../../shared/cmsPopupContract.js';

test('disposable PostgreSQL: popup ownership, RLS, CAS, duplication and permanent generations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cms-popups-'));
  const port = String(24000 + process.pid % 12000);
  const data = path.join(root, 'db');
  const run = (command, args, input) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 3e6 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  let running = false;
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'log'), '-o', `-k ${root} -p ${port} -h ''`, '-w', 'start']);
    running = true;
    const sql = text => run('psql', ['-h', root, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], text);
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE microsite(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE i_edit_page(id uuid PRIMARY KEY,tenant_id uuid,microsite_id uuid);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;`);
    sql(await readFile(new URL('./202611050001_cms_popups.sql', import.meta.url), 'utf8'));
    const document = JSON.stringify({ name: 'Notice', status: 'active', design: POPUP_EMPTY_DESIGN, config: POPUP_DEFAULT_CONFIG });
    sql(`DO $test$
    DECLARE t uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); alien uuid:=gen_random_uuid();
      pg uuid:=gen_random_uuid(); badpg uuid:=gen_random_uuid(); id uuid; copy uuid; result jsonb; doc jsonb:='${document}'::jsonb;
    BEGIN
      INSERT INTO tenant VALUES(t),(other);
      INSERT INTO member VALUES(m,t),(alien,other);
      INSERT INTO i_edit_page VALUES(pg,t,null),(badpg,other,null);
      SET LOCAL ROLE service_role;
      result:=cms_popup_save(t,null,null,doc,'create'); id:=(result->>'id')::uuid;
      IF result->>'status'<>'draft' THEN RAISE EXCEPTION 'Created active'; END IF;
      doc:=jsonb_set(doc,'{config,page_ids}',jsonb_build_array(pg));
      PERFORM cms_popup_save(t,id,1,doc,'save');
      BEGIN PERFORM cms_popup_save(t,id,1,doc,'save'); RAISE EXCEPTION 'stale accepted';
      EXCEPTION WHEN serialization_failure THEN NULL; END;
      BEGIN INSERT INTO cms_popup_page VALUES(t,id,badpg); RAISE EXCEPTION 'cross page accepted';
      EXCEPTION WHEN raise_exception THEN IF SQLERRM='cross page accepted' THEN RAISE; END IF; END;
      BEGIN PERFORM cms_popup_preference(t,id,alien,1,2,'permanent'); RAISE EXCEPTION 'cross member accepted';
      EXCEPTION WHEN raise_exception THEN IF SQLERRM='cross member accepted' THEN RAISE; END IF; END;
      PERFORM cms_popup_preference(t,id,m,1,2,'permanent');
      PERFORM cms_popup_preference(t,id,m,1,2,'permanent');
      PERFORM cms_popup_save(t,id,2,doc,'save');
      IF NOT EXISTS(SELECT 1 FROM cms_popup_member_state WHERE popup_id=id AND permanently_dismissed) THEN RAISE EXCEPTION 'edit erased choice'; END IF;
      result:=cms_popup_save(t,id,3,doc,'duplicate'); copy:=(result->>'id')::uuid;
      IF result->>'status'<>'draft' OR EXISTS(SELECT 1 FROM cms_popup_member_state WHERE popup_id=copy)
        OR NOT EXISTS(SELECT 1 FROM cms_popup_page WHERE popup_id=copy AND page_id=pg) THEN RAISE EXCEPTION 'duplicate contract'; END IF;
      result:=cms_popup_save(t,id,3,doc,'reset-dismissals');
      IF (result->>'dismissal_generation')::int<>2 THEN RAISE EXCEPTION 'reset failed'; END IF;
      BEGIN PERFORM cms_popup_preference(t,id,m,1,4,'permanent'); RAISE EXCEPTION 'old generation accepted';
      EXCEPTION WHEN serialization_failure THEN NULL; END;
      PERFORM cms_popup_save(t,id,4,doc,'delete');
      IF EXISTS(SELECT 1 FROM cms_popup_member_state WHERE popup_id=id) OR EXISTS(SELECT 1 FROM cms_popup_page WHERE popup_id=id) THEN RAISE EXCEPTION 'cleanup failed'; END IF;
    END $test$;
    DO $test$
    BEGIN
      IF has_table_privilege('anon','cms_popup','SELECT') OR has_table_privilege('authenticated','cms_popup_member_state','INSERT')
        OR has_function_privilege('anon','cms_popup_save(uuid,uuid,integer,jsonb,text)','EXECUTE')
        THEN RAISE EXCEPTION 'browser grants leaked'; END IF;
      IF (SELECT count(*) FROM pg_class WHERE relname IN ('cms_popup','cms_popup_page','cms_popup_member_state') AND relrowsecurity)<>3
        THEN RAISE EXCEPTION 'missing RLS'; END IF;
    END $test$;`);
  } finally {
    if (running) spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
