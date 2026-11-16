import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('PostgreSQL queue: atomic attach, idempotency, tenant CAS, claims, lease recovery and restricted grants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zoom-jobs-'));
  const port = String(24000 + process.pid % 12000), data = path.join(root, 'db');
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
    sql(`create role anon; create role authenticated; create role service_role bypassrls;
      create table event(id uuid primary key,tenant_id uuid,zoom_meeting_id uuid,zoom_webinar_id uuid,
        is_online boolean,online_provider text,start_date timestamptz,end_date timestamptz,timezone text);
      create table complex_event_session(id uuid primary key,tenant_id uuid,zoom_meeting_id text,zoom_webinar_id text,
        zoom_type text,online_provider text,zoom_join_url text,zoom_start_url text,zoom_registration_url text,
        start_time timestamptz,end_time timestamptz,timezone text);`);
    const migration = await readFile(new URL('./20261116090000_zoom_registration_jobs.sql', import.meta.url), 'utf8');
    sql(migration); sql(migration);
    sql(`DO $test$
    declare t uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); target uuid:=gen_random_uuid();
      req uuid:=gen_random_uuid(); j zoom_registration_job; replay zoom_registration_job;
      doc jsonb; empty_target jsonb:='{"zoom_meeting_id":null,"zoom_webinar_id":null}';
    begin
      insert into event(id,tenant_id) values(e,t);
      doc:=jsonb_build_object('tenant_id',t,'resource_kind','event','resource_id',e,'request_key',req,
        'target','{}'::jsonb,'email_requested',false,'booking_ids','[]'::jsonb);
      set local role service_role;
      j:=enqueue_zoom_registration_job(doc,empty_target,jsonb_build_object('zoom_meeting_id',target));
      replay:=enqueue_zoom_registration_job(doc,empty_target,jsonb_build_object('zoom_meeting_id',target));
      if j.id<>replay.id then raise exception 'duplicate enqueue'; end if;
      reset role;
      if (select zoom_meeting_id from event where id=e)<>target then raise exception 'attach missing'; end if;
      begin
        perform enqueue_zoom_registration_job(jsonb_set(doc,'{tenant_id}',to_jsonb(gen_random_uuid())),empty_target,'{}');
        raise exception 'cross tenant accepted';
      exception when raise_exception then if SQLERRM='cross tenant accepted' then raise; end if; end;
      begin
        perform enqueue_zoom_registration_job(jsonb_set(doc,'{request_key}',to_jsonb(gen_random_uuid())),empty_target,'{}');
        raise exception 'stale accepted';
      exception when raise_exception then if SQLERRM='stale accepted' then raise; end if; end;
      select * into j from claim_zoom_registration_job();
      if j.lease_token is null then raise exception 'no lease'; end if;
      if exists(select 1 from claim_zoom_registration_job()) then raise exception 'double claim'; end if;
      update zoom_registration_job set lease_until=now()-interval '1 second' where id=j.id;
      select * into replay from claim_zoom_registration_job();
      if replay.lease_token=j.lease_token then raise exception 'lease not fenced'; end if;
      if has_table_privilege('authenticated','zoom_registration_job','select') or
        has_function_privilege('anon','claim_zoom_registration_job()','execute') or
        has_function_privilege('authenticated','enqueue_zoom_registration_job(jsonb,jsonb,jsonb)','execute')
        then raise exception 'browser privileges'; end if;
    end $test$;`);
  } finally {
    if (running) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
