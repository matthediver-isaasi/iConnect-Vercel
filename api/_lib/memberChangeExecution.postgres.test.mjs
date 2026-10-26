import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
import {amendmentFixture,uuid} from '../../scripts/test-support/member-amendment-fixtures.mjs';
import {buildMemberAmendmentQuote} from './memberAmendmentQuote.js';
import {calculateAmendmentTerms} from './memberAmendmentCalculation.js';
test('execution bridge: concurrent approval, atomic rollback/recovery and immutable purchase', {timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('change-execution-');const clients=[];let started=false;
 const command=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  command('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  command('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  for(let i=0;i<3;i++){const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();clients.push(c);}
  const [admin,a,b]=clients;
  // Reuse the established typed purchase fixture schema, not a generic JSON
  // table that could conceal production column/constraint incompatibilities.
  const base=readFileSync(new URL('./memberAmendments.postgres.test.mjs',import.meta.url),'utf8');
  const schema=base.match(/await admin\.query\(`([\s\S]*?)`\);/)[1];
  await admin.query(schema);
  await admin.query('CREATE TABLE membership_change_policy(tenant_id uuid,policy jsonb,revision bigint)');
  for(const file of ['202612310020_member_membership_amendments.sql','202612310021_member_amendment_settlement.sql',
    '202612310023_member_change_authority.sql','202612310024_member_change_execution.sql']){
    await admin.query(readFileSync(`supabase/migrations/${file}`,'utf8'));
  }
  const today=new Date().toISOString().slice(0,10),f=amendmentFixture(today);
  await admin.query('INSERT INTO tenant VALUES($1)',[f.tenantId]);
  await admin.query('INSERT INTO member VALUES($1,$2)',[f.memberId,f.tenantId]);
  const insert=async(table,row)=>{const keys=Object.keys(row);return (await admin.query(
    `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING to_jsonb(${table}) v`,
    Object.values(row))).rows[0].v;};
  f.config=await insert('membership_tier_config',f.config);
  const governing=await insert('membership_tier_config',f.current.commitment_snapshot.config);
  f.current=await insert('member_membership_history',f.current);
  const q=buildMemberAmendmentQuote({...f,effectiveDate:today});
  const funding={complete:true,sourceRecordId:f.current.id,currency:'GBP',asOfDate:today,
    settledFunding:[{id:'verified-payment',sourceRecordId:f.current.id,currency:'GBP',state:'settled',
      ownerType:'member',ownerId:f.memberId,kind:'cash',...q.originalFullTerm}],
    pendingCollections:[],failedCollections:[],outstandingDue:{netMinor:0,vatMinor:0},
    providerEvidence:{sourceInvoiceId:'invoice',paymentIds:['payment']}};
  const calculation=calculateAmendmentTerms({sourceRecordId:f.current.id,memberId:f.memberId,currency:'GBP',
    frequency:'upfront',sourcePrice:q.originalFullTerm,term:q.term,effectiveDate:today,evidence:funding,
    behaviour:'retain_term',targetPrice:q.targetFullTerm});
  const authority={version:1,tenantId:f.tenantId,memberId:f.memberId,action:'change',request:f.request,
    sourceSnapshot:f.current,targetSnapshot:f.config,governingSnapshot:governing,
    targetBandSnapshot:null,pricingSnapshot:q.targetSnapshot,policySnapshot:null,
    fundingEvidence:funding,calculation,settlement:{requiresApproval:true,surplusHandling:'none'}};
  await a.query('SET ROLE service_role');await b.query('SET ROLE service_role');
  const saved=(await a.query('SELECT confirm_member_change_authority($1,$2,$3,$4,$5,$6) v',
    [f.tenantId,f.memberId,uuid(7),'admin','test-authority',authority])).rows[0].v;
  const begin=(client,choice='collect')=>client.query('SELECT begin_member_change_execution($1,$2,$3,$4,$5,$6) v',
    [f.tenantId,f.memberId,saved.id,uuid(7),choice,'Approve verified change']).then(r=>r.rows[0].v);
  await assert.rejects(begin(a,'credit'),/Settlement does not match/);
  const [first,second]=await Promise.all([begin(a),begin(b)]);
  assert.equal(first.amendment_id,second.amendment_id);
  await assert.rejects(begin(a,'refund'),/choice is locked/);
  const mid=first.amendment_id,args=[f.tenantId,mid,uuid(7)];
  await a.query('SELECT reserve_member_amendment_settlement($1,$2,$3,$4,$5)',[...args,'collect',{}]);
  await assert.rejects(admin.query("UPDATE member_membership_amendment_settlement SET choice='refund' WHERE amendment_id=$1",[mid]),
    /approved execution choice/);
  await assert.rejects(a.query('SELECT apply_member_membership_amendment($1,$2,$3)',args),/Verified settlement/);
  await a.query('SELECT finish_member_amendment_settlement($1,$2,$3,$4,$5)',[...args,'settled',{fixture:true}]);
  // Force failure after the application/state writes. Everything must roll back.
  await admin.query(`CREATE FUNCTION fail_application_notification() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.kind='applied' THEN RAISE EXCEPTION 'Injected final write failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_failure BEFORE INSERT ON member_membership_amendment_notification
      FOR EACH ROW EXECUTE FUNCTION fail_application_notification()`);
  await assert.rejects(a.query('SELECT apply_member_membership_amendment($1,$2,$3)',args),/Injected/);
  assert.equal((await admin.query('SELECT count(*)::int n FROM member_membership_amendment_application')).rows[0].n,0);
  assert.equal((await admin.query('SELECT state FROM member_membership_amendment_settlement')).rows[0].state,'settled');
  await admin.query("UPDATE member_membership_amendment_settlement SET next_attempt_at=now()-interval '1 minute'");
  assert.equal((await a.query('SELECT * FROM pending_member_change_executions(30)')).rows.length,1);
  await admin.query('DROP TRIGGER test_failure ON member_membership_amendment_notification');
  const applications=await Promise.all([a,b].map(c=>c.query('SELECT apply_member_membership_amendment($1,$2,$3) v',args)));
  assert.equal(applications[0].rows[0].v.id,applications[1].rows[0].v.id);
  assert.equal((await admin.query('SELECT state FROM member_membership_amendment_settlement')).rows[0].state,'applied');
  assert.equal((await a.query('SELECT * FROM pending_member_change_executions(30)')).rows.length,0);
  assert.deepEqual((await admin.query('SELECT to_jsonb(h) v FROM member_membership_history h')).rows[0].v,f.current);
  await assert.rejects(a.query('DELETE FROM member_change_execution'),/permission denied/);
  for(const role of ['anon','authenticated']){
    await b.query(`SET ROLE ${role}`);await assert.rejects(begin(b),/permission denied/);
    await assert.rejects(b.query('SELECT * FROM member_change_execution'),/permission denied/);
  }
 }finally{for(const c of clients)await c.end();if(started)command('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);await h.cleanup();}
});
