import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = name => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();

test('campaign preparation RPCs enforce lease fencing, atomic chunks, completion, cancellation and grants in isolated PostgreSQL', async () => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  assert.ok(initdb && pgCtl && psql, 'Isolated local PostgreSQL binaries required; never use application databases');
  const root = mkdtempSync(join(tmpdir(), 'campaign-preparation-integration-'));
  const data = join(root, 'data');
  const socket = join(root, 'socket');
  mkdirSync(socket);
  const run = (program, args, input = '') => {
    const result = spawnSync(program, args, { input, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${program}: ${result.stderr}\n${result.stdout}`);
    return result.stdout.trim();
  };
  let started = false;
  try {
    run(initdb, ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    run(pgCtl, ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']);
    started = true;
    const args = ['-X', '-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'];
    const query = statement => run(psql, args, statement);
    const denied = (statement, message) => {
      const result = spawnSync(psql, args, { input: statement, encoding: 'utf8', timeout: 30000 });
      assert.notEqual(result.status, 0, `Unexpectedly succeeded: ${statement}`);
      assert.match(result.stderr, message);
    };
    const tenant = '10000000-0000-4000-8000-000000000001';
    const campaign = '20000000-0000-4000-8000-000000000001';
    const cancelled = '20000000-0000-4000-8000-000000000002';
    const generation = '30000000-0000-4000-8000-000000000001';
    const cancelledGeneration = '30000000-0000-4000-8000-000000000002';
    const oldOwner = '40000000-0000-4000-8000-000000000001';
    const newOwner = '40000000-0000-4000-8000-000000000002';
    const begin = (id, gen) => `SELECT campaign_preparation_begin(
      '${id}','${tenant}',(SELECT updated_at FROM email_campaign WHERE id='${id}'),
      'draft',NULL,'${gen}')::text;`;
    const step = (gen, owner, action, payload = '{}') =>
      `SELECT campaign_preparation_step('${gen}','${owner}','${action}','${payload}'::jsonb)::text;`;
    const service = statement => query(`SET ROLE service_role; ${statement}`);

    query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY, plan_code text);
      CREATE TABLE plan(code text PRIMARY KEY, quotas jsonb);
      CREATE TABLE email_campaign(
        id uuid PRIMARY KEY, tenant_id uuid, status text, updated_at timestamptz,
        scheduled_at timestamptz, category_review_required boolean DEFAULT false,
        sent_count int DEFAULT 0, total_recipients int DEFAULT 0, sent_at timestamptz, subject text
      );
      CREATE TABLE email_campaign_recipient(
        id uuid PRIMARY KEY, campaign_id uuid REFERENCES email_campaign(id), member_id uuid,
        email text, first_name text, last_name text, status text, sent_at timestamptz
      );
      GRANT SELECT ON email_campaign TO service_role;
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text,first_name text,last_name text,
        communications_opted_out_all boolean,login_enabled boolean,organization_id uuid);
      CREATE TABLE email_unsubscribe(id uuid PRIMARY KEY,tenant_id uuid,email text,unsubscribe_type text,communication_category_id uuid);
      CREATE TABLE member_communication_preference(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,category_id uuid,is_subscribed boolean);
      CREATE TABLE complex_event_session_checkin(id uuid PRIMARY KEY,tenant_id uuid,booking_id uuid,checked_in_at timestamptz);
      ${readFileSync(new URL('../../migrations/20261001_campaign_preparation.sql', import.meta.url), 'utf8')}
      ${readFileSync(new URL('../../migrations/20261016_campaign_preparation_eligibility_feedback.sql', import.meta.url), 'utf8')}
      INSERT INTO tenant VALUES ('${tenant}', 'unlimited');
      INSERT INTO plan VALUES ('unlimited', '{}');
      INSERT INTO email_campaign(id,tenant_id,status,updated_at,subject)
      VALUES ('${campaign}','${tenant}','draft',now(),'integration'),
             ('${cancelled}','${tenant}','draft',now(),'cancellation');
    `);

    for (const role of ['anon', 'authenticated']) {
      denied(`SET ROLE ${role}; ${begin(campaign, generation)}`, /permission denied/);
      denied(`SET ROLE ${role}; ${step(generation, oldOwner, 'claim')}`, /permission denied/);
      denied(`SET ROLE ${role}; SELECT * FROM campaign_preparation;`, /permission denied/);
    }
    assert.equal(JSON.parse(service(begin(campaign, generation))).status, 'preparing');
    assert.equal(JSON.parse(service(step(generation, oldOwner, 'claim'))).lease, oldOwner);
    assert.equal(service(step(generation, newOwner, 'claim')), '');
    denied(`SET ROLE service_role; ${step(generation, newOwner, 'stage', '{"segment":0,"cursor":0,"recipients":[]}')}`, /lease expired/i);

    query(`UPDATE campaign_preparation SET lease_until=now()-interval '1 second' WHERE id='${generation}';`);
    assert.equal(JSON.parse(service(step(generation, newOwner, 'claim'))).lease, newOwner);
    denied(`SET ROLE service_role; ${step(generation, oldOwner, 'fail', '{"error":"stale owner"}')}`, /lease expired/i);
    denied(`SET ROLE service_role; ${step(generation, oldOwner, 'stage', '{"segment":0,"cursor":0,"recipients":[{"email":"stale@example.com"}]}')}`, /lease expired/i);
    assert.equal(query(`SELECT count(*) FROM campaign_preparation_recipient WHERE generation='${generation}';`), '0');

    const chunk = '{"segment":0,"cursor":0,"recipients":[{"email":"a@example.com","first_name":"A"},{"email":"b@example.com"},{"email":"a@example.com","first_name":"Duplicate"}]}';
    assert.equal(JSON.parse(service(step(generation, newOwner, 'stage', chunk))).cursor, 3);
    denied(`SET ROLE service_role; ${step(generation, newOwner, 'stage', chunk)}`, /checkpoint conflict/i);
    const oversized = JSON.stringify({
      segment: 0, cursor: 3,
      recipients: Array.from({ length: 201 }, (_, i) => ({ email: `overflow${i}@example.com` })),
    });
    denied(`SET ROLE service_role; ${step(generation, newOwner, 'stage', oversized)}`, /chunk budget/i);
    assert.equal(query(`SELECT count(*) FROM campaign_preparation_recipient WHERE generation='${generation}';`), '2');
    assert.equal(query(`SELECT cursor FROM campaign_preparation WHERE id='${generation}';`), '3');
    assert.equal(query(`SELECT recipient->>'first_name' FROM campaign_preparation_recipient WHERE generation='${generation}' AND email_key='a@example.com';`), 'A');

    denied(`SET ROLE service_role; ${step(generation, newOwner, 'resolved')}`, /segments are incomplete/i);
    denied(`UPDATE email_campaign SET status='sending' WHERE id='${campaign}';`, /partially prepared/i);
    service(step(generation, newOwner, 'segment', '{"segment":0}'));
    service(step(generation, newOwner, 'resolved'));
    denied(`SET ROLE service_role; ${step(generation, newOwner, 'complete')}`, /incomplete/i);
    service(step(generation, newOwner, 'quota'));
    denied(`SET ROLE service_role; ${step(generation, newOwner, 'complete')}`, /incomplete/i);
    assert.equal(JSON.parse(service(step(generation, newOwner, 'insert', '{"cursor":0}'))).cursor, 2);
    denied(`SET ROLE service_role; ${step(generation, newOwner, 'insert', '{"cursor":0}')}`, /checkpoint conflict/i);
    assert.equal(query(`SELECT count(*),count(DISTINCT email) FROM email_campaign_recipient WHERE campaign_id='${campaign}';`), '2|2');
    assert.equal(query(`SELECT phase FROM campaign_preparation WHERE id='${generation}';`), 'insert');
    service(step(generation, newOwner, 'complete'));
    assert.equal(query(`SELECT status||'|'||total_recipients FROM email_campaign WHERE id='${campaign}';`), 'sending|2');

    service(begin(cancelled, cancelledGeneration));
    service(step(cancelledGeneration, oldOwner, 'claim'));
    service(step(cancelledGeneration, oldOwner, 'stage', '{"segment":0,"cursor":0,"recipients":[{"email":"cancelled@example.com"}]}'));
    service(step(cancelledGeneration, oldOwner, 'segment', '{"segment":0}'));
    service(step(cancelledGeneration, oldOwner, 'resolved'));
    service(step(cancelledGeneration, oldOwner, 'quota'));
    query(`UPDATE email_campaign SET status='cancelled' WHERE id='${cancelled}';`);
    denied(`SET ROLE service_role; ${step(cancelledGeneration, oldOwner, 'insert', '{"cursor":0}')}`, /no longer authorized/i);
    denied(`SET ROLE service_role; ${step(cancelledGeneration, oldOwner, 'complete')}`, /no longer authorized/i);
    denied(`SET ROLE service_role; ${step(cancelledGeneration, newOwner, 'claim')}`, /no longer authorized/i);
    assert.equal(query(`SELECT count(*) FROM email_campaign_recipient WHERE campaign_id='${cancelled}';`), '0');
    assert.equal(query(`SELECT status FROM email_campaign WHERE id='${cancelled}';`), 'cancelled');

    // Run the real cron worker, streaming resolver, and detail service against
    // this disposable database. The transport adapter implements PostgREST
    // read shaping only; all state transitions execute the actual SQL RPC.
    query(`UPDATE email_campaign SET status='cancelled' WHERE status='sending';
      ALTER TABLE email_campaign ADD COLUMN target_audiences jsonb;
      ALTER TABLE email_campaign ADD COLUMN from_email text DEFAULT 'sender@example.com';
      ALTER TABLE email_campaign ADD COLUMN opened_count integer DEFAULT 0;
      ALTER TABLE email_campaign ADD COLUMN clicked_count integer DEFAULT 0;
      ALTER TABLE email_campaign ADD COLUMN delivered_count integer DEFAULT 0;`);
    process.env.SUPABASE_URL='https://campaign-preparation.invalid';
    process.env.SUPABASE_SERVICE_KEY='isolated-test-key';
    const { supabase }=await import('./database.js');
    const { processScheduledCampaigns, processPreparingCampaigns, getCampaign, getTargetRecipients }=await import('./campaignService.js');
    const { prepareCampaignAudience }=await import('./campaignPreparation.js');
    const { resolvePreparationChunk }=await import('./campaignPreparationStream.js');
    const originalFrom=supabase.from, originalRpc=supabase.rpc;
    const literal=value=>`'${(typeof value==='object'?JSON.stringify(value):String(value)).replaceAll("'","''")}'`;
    let rpcCalls=0;
    supabase.rpc=async(name,parameters)=>{
      if (name === 'campaign_preparation_email_members') {
        const data=JSON.parse(query(`SELECT coalesce(jsonb_agg(t),'[]') FROM campaign_preparation_email_members(
          ${literal(parameters.p_tenant)}::uuid, ARRAY[${parameters.p_emails.map(literal).join(',')}]::text[], ${parameters.p_trim === true}) t;`));
        return {data,error:null};
      }
      if (name === 'campaign_preparation_attended_bookings') return {data:[],error:null};
      assert.equal(name,'campaign_preparation_step');rpcCalls++;
      const statement=`SELECT ${name}(${Object.entries(parameters).map(([key,value])=>`${key}=>${literal(value)}`).join(',')})::text;`;
      const result=spawnSync(psql,args,{input:statement,encoding:'utf8',timeout:30000});
      return result.status===0?{data:JSON.parse(result.stdout.trim()||'null'),error:null}
        :{data:null,error:{code:'P0001',message:result.stderr.split('\n').find(line=>line.includes('ERROR:'))?.replace(/^.*ERROR:\s*/,'') || result.stderr}};
    };
    supabase.from=table=>{
      assert.match(table,/^[a-z_]+$/);
      const filters=[];let single=false,max=Infinity,count=false,order,start=0,end=Infinity;
      const get=(row,key)=>key.split('.').reduce((value,k)=>value?.[k],row);
      const q={
        select(_columns,options){count=options?.count==='exact';return q;},
        eq(k,v){filters.push(r=>get(r,k)===v);return q;},
        neq(k,v){filters.push(r=>get(r,k)!==v);return q;},
        gt(k,v){filters.push(r=>get(r,k)>v);return q;},
        gte(k,v){filters.push(r=>get(r,k)>=v);return q;},
        lt(k,v){filters.push(r=>get(r,k)<v);return q;},
        lte(k,v){filters.push(r=>get(r,k)!=null&&get(r,k)<=v);return q;},
        is(k,v){filters.push(r=>(get(r,k)??null)===v);return q;},
        in(k,v){filters.push(r=>v.includes(get(r,k)));return q;},
        not(k,op,v){filters.push(r=>op==='is'?get(r,k)!==v:!/^deleted_.*@deleted\.local$/i.test(get(r,k)||''));return q;},
        order(k){order=k;return q;},limit(n){max=n;return q;},
        range(a,b){start=a;end=b;return q;},
        single(){single=true;return q;},maybeSingle(){single=true;return q;},abortSignal(){return q;},
        then(resolve,reject){
          try{
            let rows=JSON.parse(query(`SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM ${table} t;`));
            if(table==='campaign_preparation'){
              const campaigns=JSON.parse(query("SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM email_campaign t;"));
              rows=rows.map(r=>({...r,email_campaign:campaigns.find(c=>c.id===r.campaign_id)}));
            }
            rows=rows.filter(r=>filters.every(f=>f(r)));
            if(order)rows.sort((a,b)=>a[order]<b[order]?-1:1);
            const total=rows.length;rows=rows.slice(start,end+1).slice(0,max);
            return Promise.resolve({data:single?rows[0]||null:rows,error:null,count:count?total:null}).then(resolve,reject);
          }catch(error){return Promise.reject(error).then(resolve,reject);}
        },
      };return q;
    };
    try{
      // Nested saved lists -> real streamed candidates -> real SQL global and
      // category consent. This is not the JS fixture's simplified consent model.
      query(`
        ALTER TABLE email_campaign ADD COLUMN communication_category_id uuid;
        CREATE TABLE audience_list(id uuid primary key,tenant_id uuid,target_audiences jsonb,
          ignore_opt_outs boolean default false,category_review_required boolean default false);
        CREATE TABLE audience_list_external_contact(id uuid,tenant_id uuid,audience_list_id uuid,email text,first_name text,last_name text);
        CREATE TABLE booking(id uuid,tenant_id uuid,event_id uuid,status text,attendee_email text,
          attendee_first_name text,attendee_last_name text,member_id uuid,checked_in_at timestamptz,ticket_class_id uuid,ticket_class_name text);
        CREATE TABLE complex_event_booking (LIKE booking);
        CREATE TABLE attendance_current_outcome(tenant_id uuid,booking_type text,booking_id uuid,status text,attendance_target jsonb,attendance_target_id uuid,provider text);
      `);
      const event='70000000-0000-4000-8000-000000000001',category='70000000-0000-4000-8000-000000000002';
      const parent='70000000-0000-4000-8000-000000000003',child='70000000-0000-4000-8000-000000000004';
      const targets=[{type:'audience_list',ids:[parent]}];
      const eventSegment={type:'event_attendees',ids:[event],attendance_selection:{[event]:'attended'},
        ticket_type_selection:{[event]:[{name:'Standard'}]}};
      query(`INSERT INTO audience_list(id,tenant_id,target_audiences) VALUES
        ('${parent}','${tenant}',${literal([{type:'audience_list',ids:[child]}])}),
        ('${child}','${tenant}',${literal([eventSegment])});`);
      const names=['subscribed','missing','global','guest','category-out','duplicate','not-attended','cancelled','wrong-ticket'];
      for (const [i,name] of names.entries()) {
        const booking=`80000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
        query(`INSERT INTO booking(id,tenant_id,event_id,status,attendee_email)
          VALUES('${booking}','${tenant}','${event}','${name==='cancelled'?'cancelled':'confirmed'}','${name}@example.test');`);
        if(name!=='not-attended') query(`INSERT INTO attendance_current_outcome VALUES
          ('${tenant}','booking','${booking}','attended',${literal({tenant_id:tenant,tracking_enabled:true})},'${event}','zoom');`);
        if (['subscribed','missing','global','duplicate'].includes(name)) {
          const member=`90000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
          query(`INSERT INTO member(id,tenant_id,email,communications_opted_out_all) VALUES
            ('${member}','${tenant}','${name}@example.test',${name==='global'});
            INSERT INTO member_communication_preference VALUES(gen_random_uuid(),'${tenant}','${member}','${category}',${name==='subscribed'});`);
        }
      }
      query(`UPDATE booking SET ticket_class_name=case when attendee_email='wrong-ticket@example.test' then 'Other' else 'Standard' end;
        INSERT INTO booking SELECT '80000000-0000-4000-8000-000000000099',tenant_id,event_id,status,attendee_email,
          attendee_first_name,attendee_last_name,member_id,checked_in_at,ticket_class_id,ticket_class_name
          FROM booking WHERE attendee_email='guest@example.test';
        INSERT INTO attendance_current_outcome SELECT tenant_id,booking_type,'80000000-0000-4000-8000-000000000099',
          status,attendance_target,attendance_target_id,provider FROM attendance_current_outcome
          WHERE booking_id='80000000-0000-4000-8000-000000000004';`);
      // Highest ID is authoritative even when a lower duplicate is subscribed.
      query(`INSERT INTO member(id,tenant_id,email) VALUES('90000000-0000-4000-8000-000000000099','${tenant}','duplicate@example.test');
        UPDATE member_communication_preference SET is_subscribed=true WHERE member_id='90000000-0000-4000-8000-000000000006';
        INSERT INTO email_unsubscribe VALUES(gen_random_uuid(),'${tenant}','category-out@example.test','category','${category}');`);
      for (const [index,mode] of ['eligible','category-empty','global-empty','source-empty'].entries()) {
        const id=`20000000-0000-4000-8000-${String(index+20).padStart(12,'0')}`;
        const gen=`30000000-0000-4000-8000-${String(index+20).padStart(12,'0')}`;
        if(mode==='category-empty') query(`UPDATE member_communication_preference SET is_subscribed=false;
          INSERT INTO email_unsubscribe VALUES(gen_random_uuid(),'${tenant}','guest@example.test','category','${category}');`);
        if(mode==='global-empty') query(`INSERT INTO email_unsubscribe SELECT gen_random_uuid(),'${tenant}',attendee_email,'all',null FROM booking;`);
        if(mode==='source-empty') query(`DELETE FROM attendance_current_outcome;`);
        const snapshot={target_audiences:targets,communication_category_id:category};
        const preview=await getTargetRecipients(snapshot,tenant);
        assert.equal(preview.success,true,preview.error);
        assert.deepEqual(preview.recipients.map(r=>r.email).sort(),mode==='eligible'?['guest@example.test','subscribed@example.test']:[]);
        if(mode==='eligible') {
          const rpc=supabase.rpc;
          try {
            supabase.rpc=async(name,p)=>name==='campaign_preparation_email_members'
              ? {data:null,error:{code:'08006',message:'Identity lookup unavailable'}}
              : rpc(name,p);
            const failedPreview=await getTargetRecipients(snapshot,tenant);
            assert.equal(failedPreview.success,false);
            assert.equal(failedPreview.error,'Identity lookup unavailable');
            assert.equal(failedPreview.recipients,undefined);
          } finally {supabase.rpc=rpc;}
        }
        query(`INSERT INTO email_campaign(id,tenant_id,status,updated_at,target_audiences,communication_category_id)
          VALUES('${id}','${tenant}','draft',now(),${literal(targets)},'${category}');`);
        service(begin(id,gen));
        const run=()=>prepareCampaignAudience({db:supabase,generation:gen,resolveChunk:resolvePreparationChunk,
          authorize:async()=>{},quota:async()=>({ok:true}),deadline:Date.now()+120000});
        // Lost response after a committed stream transition must not duplicate
        // candidates, counters or recipients on the next claim.
        const rpc=supabase.rpc;let lost=false;
        supabase.rpc=async(name,p)=>{
          const result=await rpc(name,p);
          if(mode==='eligible'&&!lost&&p.p_action==='stream'){lost=true;throw Object.assign(new Error('connection reset'),{code:'ECONNRESET'});}
          return result;
        };
        let result;
        try { result=await run(); if(mode==='eligible') result=await run(); }
        finally {supabase.rpc=rpc;}
        if(mode==='eligible') {
          assert.equal(result.success,true,result.error);
          assert.equal(result.totalRecipients,2);
          assert.equal(query(`SELECT count(*) FROM email_campaign_recipient WHERE campaign_id='${id}';`),'2');
          assert.equal(query(`SELECT candidate_count FROM campaign_preparation WHERE id='${gen}';`),'6');
          query(`UPDATE email_campaign SET status='cancelled' WHERE id='${id}';`);
        } else {
          assert.equal(result.terminal,true);
          assert.match(result.error,mode==='source-empty'?/No contacts matched/:mode==='global-empty'?/6 excluded by global consent/:/5 by category eligibility/);
          assert.equal(query(`SELECT count(*) FROM email_campaign_recipient WHERE campaign_id='${id}';`),'0');
        }
      }
      // Incident-shaped fixture: 189 confirmed bookings, no check-ins, 74
      // published Zoom outcomes, saved-list targeting, no campaign category.
      query(`TRUNCATE booking,attendance_current_outcome,member_communication_preference,email_unsubscribe;
        INSERT INTO booking(id,tenant_id,event_id,status,attendee_email,ticket_class_name)
          SELECT ('80000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'${tenant}','${event}',
            'confirmed','incident-'||i||'@example.test','Standard' FROM generate_series(1,189) i;
        INSERT INTO attendance_current_outcome
          SELECT tenant_id,'booking',id,'attended',${literal({tenant_id:tenant,tracking_enabled:true})},
            '${event}','zoom' FROM booking ORDER BY id LIMIT 74;`);
      const incident='20000000-0000-4000-8000-000000000030',incidentGen='30000000-0000-4000-8000-000000000030';
      const incidentPreview=await getTargetRecipients({target_audiences:targets},tenant);
      assert.equal(incidentPreview.recipients.length,74);
      query(`INSERT INTO email_campaign(id,tenant_id,status,updated_at,target_audiences)
        VALUES('${incident}','${tenant}','draft',now(),${literal(targets)});`);
      service(begin(incident,incidentGen));
      const preparedIncident=await prepareCampaignAudience({db:supabase,generation:incidentGen,
        resolveChunk:resolvePreparationChunk,authorize:async()=>{},quota:async()=>({ok:true}),deadline:Date.now()+120000});
      assert.equal(preparedIncident.totalRecipients,74,preparedIncident.error);
      assert.equal(query(`SELECT count(*) FROM email_campaign_recipient WHERE campaign_id='${incident}';`),'74');
      query(`UPDATE email_campaign SET status='cancelled' WHERE id='${incident}';`);
      for(const [index,target,expected] of [
        [3,{type:'role',ids:['empty-role']},/No contacts matched/],
        [4,{type:'invalid-target',ids:['x']},/Invalid or disallowed audience/],
        [5,{type:'role',ids:['empty-role']},/no longer authorized/],
      ]){
        const id=`20000000-0000-4000-8000-00000000000${index}`;
        const gen=`30000000-0000-4000-8000-00000000000${index}`;
        query(`INSERT INTO email_campaign(id,tenant_id,status,updated_at,target_audiences)
          VALUES('${id}','${tenant}','draft',now(),${literal([target])}::jsonb);`);
        service(begin(id,gen));
        if(index===5)query(`UPDATE email_campaign SET category_review_required=true WHERE id='${id}';`);
        const result=await processScheduledCampaigns();
        assert.equal(result.success,false);
        assert.equal(result.preparingCampaigns.success,false);
        assert.match(result.error,expected);
        assert.equal(query(`SELECT status FROM email_campaign WHERE id='${id}';`),'failed');
        assert.equal(query(`SELECT phase FROM campaign_preparation WHERE id='${gen}';`),'failed');
        assert.match(query(`SELECT last_error FROM campaign_preparation WHERE id='${gen}';`),expected);
        assert.equal(query(`SELECT count(*) FROM email_campaign_recipient WHERE campaign_id='${id}';`),'0');
        const detail=await getCampaign(id,tenant);
        assert.equal(detail.success,true);
        assert.equal(detail.campaign.status,'failed');
        assert.match(detail.campaign.preparation.last_error,expected);
        const before=rpcCalls;
        const again=await processScheduledCampaigns();
        assert.equal(again.success,true);
        assert.equal(again.preparingCampaigns.processed,0);
        assert.equal(rpcCalls,before,'terminal generations must never be retried automatically');
        denied(`SET ROLE service_role; ${step(gen,newOwner,'resume')}`,/cannot resume/i);
      }
      const quotaCampaign='20000000-0000-4000-8000-000000000006';
      const quotaGeneration='30000000-0000-4000-8000-000000000006';
      const role='50000000-0000-4000-8000-000000000001';
      query(`ALTER TABLE member ADD COLUMN role_id uuid;
        INSERT INTO member(id,tenant_id,email,role_id) VALUES
          ('60000000-0000-4000-8000-000000000001','${tenant}','quota@example.com','${role}');
        INSERT INTO email_campaign(id,tenant_id,status,updated_at,target_audiences)
          VALUES('${quotaCampaign}','${tenant}','draft',now(),${literal([{type:'role',ids:[role]}])}::jsonb);
        UPDATE plan SET quotas='{"emails_per_month":0}';`);
      service(begin(quotaCampaign,quotaGeneration));
      const blocked=await processScheduledCampaigns();
      assert.equal(blocked.success,false);
      assert.match(blocked.error,/quota exceeded/);
      assert.equal(blocked.preparingCampaigns.campaigns[0].retryable,true);
      assert.equal(query(`SELECT status FROM email_campaign WHERE id='${quotaCampaign}';`),'preparing');
      assert.equal(query(`SELECT phase FROM campaign_preparation WHERE id='${quotaGeneration}';`),'quota');
      assert.equal(query(`SELECT count(*) FROM email_campaign_recipient WHERE campaign_id='${quotaCampaign}';`),'0');
      assert.match((await getCampaign(quotaCampaign,tenant)).campaign.preparation.last_error,/quota exceeded/);
      query("UPDATE plan SET quotas='{}';");
      const recovered=await processPreparingCampaigns();
      assert.equal(recovered.success,true);
      assert.equal(query(`SELECT status FROM email_campaign WHERE id='${quotaCampaign}';`),'sending');
      assert.equal(query(`SELECT count(*) FROM email_campaign_recipient WHERE campaign_id='${quotaCampaign}';`),'1');
      query(`UPDATE email_campaign SET status='cancelled' WHERE id='${quotaCampaign}';`);
      denied(`SET ROLE service_role; ${step(cancelledGeneration,oldOwner,'fail','{"error":"stale"}')}`,/no longer authorized/i);
    }finally{
      supabase.from=originalFrom;supabase.rpc=originalRpc;
    }
  } finally {
    if (started) run(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(root, { recursive: true, force: true });
  }
});