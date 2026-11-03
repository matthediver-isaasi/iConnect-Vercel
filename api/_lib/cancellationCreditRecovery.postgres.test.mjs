import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
test('cancellation credit queue is service-only and unique; optimistic claims are single-writer',{timeout:120000},async()=>{
  const h=await createLocalPostgresHarness('cancellation-credit-'),clients=[];let started=false;
  const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  try{
    cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
    for(let i=0;i<3;i++){const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();clients.push(c);}
    const [admin,a,b]=clients;
    await admin.query('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE TABLE tenant(id uuid PRIMARY KEY);');
    const sql=readFileSync('supabase/migrations/202612060001_cancellation_credit_recovery.sql','utf8');
    await admin.query(sql);await admin.query(sql);
    await admin.query("INSERT INTO tenant VALUES('00000000-0000-4000-8000-000000000001')");
    await a.query('SET ROLE service_role');await b.query('SET ROLE service_role');
    const insert=`INSERT INTO cancellation_credit_operation(tenant_id,operation_key,booking_source,booking_ids,invoice_id,company_id,amount,description,reference)
      VALUES('00000000-0000-4000-8000-000000000001','cancel:test','booking',ARRAY['00000000-0000-4000-8000-000000000002']::uuid[],'invoice','company',200,'Cancellation','Cancel:test') RETURNING id`;
    const id=(await a.query(insert)).rows[0].id;
    await assert.rejects(b.query(insert),{code:'23505'});
    const claim=client=>client.query("UPDATE cancellation_credit_operation SET state='processing' WHERE id=$1 AND state='pending' RETURNING id",[id]);
    const results=await Promise.all([claim(a),claim(b)]);assert.equal(results.reduce((n,r)=>n+r.rowCount,0),1);
    for(const role of ['anon','authenticated']){
      await a.query(`RESET ROLE;SET ROLE ${role}`);
      await assert.rejects(a.query('SELECT * FROM cancellation_credit_operation'),{code:'42501'});
      await assert.rejects(a.query(insert),{code:'42501'});
    }
  }finally{
    await Promise.all(clients.map(c=>c.end()));
    if(started)cmd('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
