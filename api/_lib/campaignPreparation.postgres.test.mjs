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
    const { processScheduledCampaigns, processPreparingCampaigns, getCampaign }=await import('./campaignService.js');
    const originalFrom=supabase.from, originalRpc=supabase.rpc;
    const literal=value=>`'${(typeof value==='object'?JSON.stringify(value):String(value)).replaceAll("'","''")}'`;
    let rpcCalls=0;
    supabase.rpc=async(name,parameters)=>{
      assert.equal(name,'campaign_preparation_step');rpcCalls++;
      const statement=`SELECT ${name}(${Object.entries(parameters).map(([key,value])=>`${key}=>${literal(value)}`).join(',')})::text;`;
      const result=spawnSync(psql,args,{input:statement,encoding:'utf8',timeout:30000});
      return result.status===0?{data:JSON.parse(result.stdout.trim()||'null'),error:null}
        :{data:null,error:{code:'P0001',message:result.stderr.split('\n').find(line=>line.includes('ERROR:'))?.replace(/^.*ERROR:\s*/,'') || result.stderr}};
    };
    supabase.from=table=>{
      assert.match(table,/^[a-z_]+$/);
      const filters=[];let single=false,max=Infinity,count=false,order;
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
            const total=rows.length;rows=rows.slice(0,max);
            return Promise.resolve({data:single?rows[0]||null:rows,error:null,count:count?total:null}).then(resolve,reject);
          }catch(error){return Promise.reject(error).then(resolve,reject);}
        },
      };return q;
    };
    try{
      for(const [index,target,expected] of [
        [3,{type:'role',ids:['empty-role']},/No recipients found/],
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