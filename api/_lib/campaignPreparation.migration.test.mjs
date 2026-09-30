import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway local PostgreSQL cluster, never DATABASE_URL/SUPABASE_URL.
// Skips where PostgreSQL server binaries are not installed.
const hasPostgres = process.env.TEST_ISOLATION_ALLOW_LOCAL_PG === '1'
  && spawnSync('sh',['-c','command -v initdb']).status===0;
test('real PostgreSQL: atomic checkpoints, quota reservations, cancellation, pause and generation fences',
  {skip:!hasPostgres},()=>{
  const root=mkdtempSync(join(tmpdir(),'campaign-preparation-pg-'));
  const data=join(root,'data');
  const command=(name,args,input)=>{
    const r=spawnSync(name,args,{input,encoding:'utf8',timeout:30000});
    assert.equal(r.status,0,`${name}: ${r.stderr}\n${r.stdout}`);
    return r.stdout;
  };
  let started=false;
  try{
    command('initdb',['-D',data,'-A','trust','-U','postgres','--no-locale']);
    command('pg_ctl',['-D',data,'-l',join(root,'postgres.log'),'-o',`-F -k ${root} -h '' -p 65439`,'-w','start']);
    started=true;
    const sql=`
      create role anon; create role authenticated; create role service_role;
      create table tenant(id uuid primary key,plan_code text);
      create table plan(code text primary key,quotas jsonb);
      create table email_campaign(
        id uuid primary key,tenant_id uuid,status text,updated_at timestamptz,scheduled_at timestamptz,
        category_review_required boolean default false,sent_count int default 0,total_recipients int default 0,
        sent_at timestamptz,subject text
      );
      create table email_campaign_recipient(
        id uuid primary key,campaign_id uuid references email_campaign(id),member_id uuid,email text,
        first_name text,last_name text,status text,sent_at timestamptz
      );
      create table member(id uuid primary key,tenant_id uuid,email text,first_name text,last_name text,
        communications_opted_out_all boolean,login_enabled boolean,organization_id uuid);
      create table email_unsubscribe(id uuid primary key,tenant_id uuid,email text,unsubscribe_type text,communication_category_id uuid);
      create table member_communication_preference(id uuid primary key,tenant_id uuid,member_id uuid,category_id uuid,is_subscribed boolean);
      create table complex_event_session_checkin(id uuid primary key,tenant_id uuid,booking_id uuid,checked_in_at timestamptz);
      ${readFileSync(new URL('../../migrations/20261001_campaign_preparation.sql',import.meta.url),'utf8')}
      insert into tenant values('00000000-0000-0000-0000-000000000001','limited');
      insert into plan values('limited','{"emails_per_month":3}');
      do $test$
      declare
        tenant_id uuid := '00000000-0000-0000-0000-000000000001';
        c uuid := gen_random_uuid(); c2 uuid := gen_random_uuid();
        g uuid := gen_random_uuid(); g2 uuid := gen_random_uuid();
        owner uuid := gen_random_uuid(); second_owner uuid := gen_random_uuid();
        v timestamptz := now(); rejected boolean; result jsonb;
      begin
        insert into email_campaign(id,tenant_id,status,updated_at,subject) values(c,tenant_id,'draft',v,'original'),(c2,tenant_id,'draft',v,'second');
        perform campaign_preparation_begin(c,tenant_id,v,'draft',null,g);
        perform campaign_preparation_begin(c2,tenant_id,v,'draft',null,g2);
        perform campaign_preparation_step(g,owner,'claim');
        result:=campaign_preparation_step(g,second_owner,'claim');
        if result is not null then raise exception 'Concurrent owner acquired lease'; end if;
        update campaign_preparation set lease_until=now()-interval '1 second' where id=g;
        perform campaign_preparation_step(g,second_owner,'claim');
        rejected:=false;
        begin perform campaign_preparation_step(g,owner,'read','{"segment":0,"sequence":0,"key":"old","result":{}}');
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'Expired owner checkpoint accepted'; end if;
        perform campaign_preparation_step(g,second_owner,'release');
        perform campaign_preparation_step(g,owner,'claim');
        rejected:=false;
        begin perform campaign_preparation_step(g,owner,'resolved');
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'Incomplete resolution accepted'; end if;
        rejected:=false;
        begin update email_campaign set status='sending' where id=c;
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'Partial audience was promoted'; end if;
        perform campaign_preparation_step(g,owner,'stage','{"segment":0,"cursor":0,"recipients":[{"email":"a@example.com"},{"email":"b@example.com"},{"email":"a@example.com"}]}');
        -- Duplicate emails never inflate quota, while the input cursor advances.
        if (select count(*) from campaign_preparation_recipient where generation=g)<>2 then raise exception 'Dedup failed'; end if;
        perform campaign_preparation_step(g,owner,'segment','{"segment":0}');
        perform campaign_preparation_step(g,owner,'resolved');
        perform campaign_preparation_step(g,owner,'quota');
        perform campaign_preparation_step(g2,second_owner,'claim');
        perform campaign_preparation_step(g2,second_owner,'stage','{"segment":0,"cursor":0,"recipients":[{"email":"c@example.com"},{"email":"d@example.com"}]}');
        perform campaign_preparation_step(g2,second_owner,'segment','{"segment":0}');
        perform campaign_preparation_step(g2,second_owner,'resolved');
        rejected:=false;
        begin perform campaign_preparation_step(g2,second_owner,'quota');
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'Concurrent quota reservation overbooked'; end if;
        -- Paused partial preparation retains its reservation and cannot send.
        update email_campaign set status='paused',updated_at=clock_timestamp() where id=c;
        rejected:=false;
        begin perform campaign_preparation_step(g,owner,'insert','{"cursor":0}');
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'Paused owner wrote recipients'; end if;
        perform campaign_preparation_step(g,owner,'resume');
        perform campaign_preparation_step(g,owner,'claim');
        perform campaign_preparation_step(g,owner,'insert','{"cursor":0}');
        if (select count(*) from email_campaign_recipient where campaign_id=c)<>2 then raise exception 'Chunk insert failed'; end if;
        -- A lost insert response cannot replay a stale cursor.
        rejected:=false;
        begin perform campaign_preparation_step(g,owner,'insert','{"cursor":0}');
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'Stale insertion cursor accepted'; end if;
        -- Exact content changes fence promotion even with unchanged timestamp.
        update email_campaign set subject='changed' where id=c;
        rejected:=false;
        begin perform campaign_preparation_step(g,owner,'complete');
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'Changed generation promoted'; end if;
        update email_campaign set subject='original' where id=c;
        perform campaign_preparation_step(g,owner,'complete');
        if (select status from email_campaign where id=c)<>'sending' then raise exception 'Complete audience not promoted'; end if;
        -- Cancellation frees a reservation, but can never be revived by a
        -- checkpoint from the old owner.
        update email_campaign set status='cancelled' where id=c2;
        rejected:=false;
        begin perform campaign_preparation_step(g2,second_owner,'quota');
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'Cancelled preparation wrote'; end if;
      end $test$;
      do $stream$
      declare t uuid:='00000000-0000-0000-0000-000000000001';c uuid:=gen_random_uuid();
        g uuid:=gen_random_uuid();owner uuid:=gen_random_uuid();state jsonb;rejected boolean:=false;
      begin
        insert into email_campaign(id,tenant_id,status,updated_at)
          values(c,t,'draft',now());
        perform campaign_preparation_begin(c,t,(select updated_at from email_campaign where id=c),'draft',null,g);
        perform campaign_preparation_step(g,owner,'claim');
        insert into email_unsubscribe values(gen_random_uuid(),t,'unsub@example.com','all',null);
        state:=campaign_preparation_step(g,owner,'stream',jsonb_build_object(
          'segment',0,'expected','{}'::jsonb,'continuation','{"cursor":"one"}'::jsonb,'done',true,
          'facts','[{"bucket":"evidence","key":"one","value":{"verified":true}}]'::jsonb,
          'candidates','[
            {"email":"blocked@example.com","communications_opted_out_all":true},
            {"email":"unsub@example.com"},
            {"email":"guest@example.com","first_name":"first"},
            {"email":"GUEST@example.com","first_name":"later"}
          ]'::jsonb));
        if (select count(*) from campaign_preparation_candidate where generation=g)<>4
          or (select count(*) from campaign_preparation_fact where generation=g)<>1
          or (state->>'segment')::integer<>1 then raise exception 'Streaming checkpoint was not atomic'; end if;
        begin perform campaign_preparation_step(g,owner,'stream',
          '{"segment":0,"expected":{},"continuation":{},"done":true,"facts":[],"candidates":[]}'::jsonb);
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'Lost-response streaming checkpoint replay was accepted'; end if;
        state:=campaign_preparation_step(g,owner,'stream_resolved');
        while state->>'phase' in ('global_consent','consent') loop
          state:=campaign_preparation_step(g,owner,state->>'phase',jsonb_build_object('cursor',state->'cursor'));
        end loop;
        if (state->>'total')::integer<>1 or state->>'phase'<>'quota'
          or (select recipient->>'first_name' from campaign_preparation_recipient where generation=g)<>'first'
          then raise exception 'Stream consent or precedence changed'; end if;
        perform campaign_preparation_step(g,owner,'quota');
        state:=campaign_preparation_step(g,owner,'insert','{"cursor":0}');
        perform campaign_preparation_step(g,owner,'complete');
        if (select status from email_campaign where id=c)<>'sending'
          or (select count(*) from email_campaign_recipient where campaign_id=c)<>1
          then raise exception 'Stream did not promote exactly its final audience'; end if;
        if has_function_privilege('authenticated','campaign_preparation_email_members(uuid,text[],boolean)','execute')
          then raise exception 'Read helper exposed to authenticated users'; end if;
      end $stream$;
    `;
    command('psql',['-h',root,'-p','65439','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],sql);
  } finally{
    if(started) spawnSync('pg_ctl',['-D',data,'-m','immediate','-w','stop'],{timeout:30000});
    rmSync(root,{recursive:true,force:true});
  }
});