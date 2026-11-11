import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {connectDestination} from './lib/member-index-destination.mjs';
import {TENANT,FIELD,SUCCESSOR,planMember,hash} from './reconstruct-bnms-student-terms.mjs';
import {canvasRenewalEligibility} from '../api/_lib/canvasRenewalEligibility.js';
const dates={'12f7a3d3-f698-4921-b11d-8bcbd4f0db4c':'2026-01-04',
  '847a77b3-c81f-4cfa-90fb-15c0cde104fd':'2026-09-08'};
const test='c2c73ebc-3b90-5c25-a724-fd1e7265432b';
const path='generated-artifacts/bnms-student-reconstruction';
const mode=process.argv[2];assert(['rehearse','apply','verify'].includes(mode));
const db=await connectDestination();
try{
  await db.query(mode==='verify'?'begin read only':'begin isolation level serializable');
  await db.query("set local lock_timeout='5s';set local statement_timeout='30s'");
  const read=async(table,sql,args)=>(await db.query(`select to_jsonb(x) row from ${table} x ${sql}`,args)).rows.map(r=>r.row);
  const originalTest=await read('member','where id=$1',[test]);
  const originalTestHistory=await read('member_membership_history','where member_id=$1 order by id',[test]);
  const config=(await read('membership_tier_config','where tenant_id=$1 and id=$2',[TENANT,SUCCESSOR]))[0];
  const field=(await read('preference_field','where tenant_id=$1 and id=$2',[TENANT,FIELD]))[0];
  assert.equal(config.term_end_mode,'member_date_field');assert.equal(config.is_active,true);
  const results=[];
  const reviewed=mode==='apply'?JSON.parse(await readFile(`${path}/two-dates-rehearse.json`,'utf8')):null;
  for(const [id,date] of Object.entries(dates)){
    const member=(await read('member',`where tenant_id=$1 and id=$2 ${mode==='verify'?'':'for update'}`,[TENANT,id]))[0];
    assert(member);
    assert.equal((await db.query('select name from role where tenant_id=$1 and id=$2',[TENANT,member.role_id])).rows[0]?.name,'Student');
    const prefs=await read('member_preference_value',`where member_id=$1 order by id ${mode==='verify'?'':'for share'}`,[id]);
    const history=await read('member_membership_history','where tenant_id=$1 and member_id=$2 order by id',[TENANT,id]);
    const agreements=await read('membership_billing_agreements','where tenant_id=$1 and member_id=$2',[TENANT,id]);
    assert.equal(agreements.length,0);
    if(mode==='verify'){
      assert.equal(member.created_on.slice(0,10),date);assert.equal(history.length,1);
      const saved=history[0];assert.equal(saved.config_id,SUCCESSOR);
      assert.equal(saved.term_start_date,date);assert.equal(saved.term_end_date,prefs.find(p=>p.field_id===FIELD).value);
      assert.equal(saved.final_cost,0);assert.equal(saved.payment_status,'paid');
      assert.equal(canvasRenewalEligibility({record:{...saved,membership_source:'personal'},config,history:[],
        today:saved.membership_renewal_date}).eligible,true);
      results.push({id,name:`${member.first_name} ${member.last_name}`,start:date,end:saved.term_end_date});continue;
    }
    assert.equal(member.created_on,null);assert.equal(history.length,0);
    const plan=planMember({...member,created_on:date},history,prefs,field,config,new Date().toISOString().slice(0,10));
    assert.equal(plan.outcome,'create');
    const fingerprint=hash({member,prefs,history,config,plan,agreements});
    if(reviewed)assert.equal(reviewed.find(r=>r.id===id)?.fingerprint,fingerprint);
    await db.query('update member set created_on=$1 where tenant_id=$2 and id=$3 and created_on is null',[`${date}T00:00:00Z`,TENANT,id]);
    const updated=(await read('member','where id=$1',[id]))[0];
    for(const key of Object.keys(member))if(!['created_on','updated_at','survey_invitation_revision'].includes(key))
      assert.deepEqual(updated[key],member[key],key);
    assert.equal(updated.survey_invitation_revision,member.survey_invitation_revision+1);
    const columns=Object.keys(plan.record).map(k=>`"${k}"`).join(',');
    await db.query('set local role service_role');
    await db.query(`insert into member_membership_history(${columns}) select ${columns}
      from jsonb_populate_record(null::member_membership_history,$1::jsonb)`,[JSON.stringify(plan.record)]);
    await db.query('reset role');
    const saved=(await read('member_membership_history','where id=$1',[plan.record.id]))[0];
    for(const [k,v]of Object.entries(plan.record))assert.deepEqual(saved[k],v);
    assert.deepEqual(await read('member_preference_value','where member_id=$1 order by id',[id]),prefs);
    results.push({id,name:plan.name,start:date,end:plan.end,fingerprint,before:member,historyId:saved.id});
  }
  assert.deepEqual(await read('member','where id=$1',[test]),originalTest);
  assert.deepEqual(await read('member_membership_history','where member_id=$1 order by id',[test]),originalTestHistory);
  await writeFile(`${path}/two-dates-${mode}.json`,JSON.stringify(results,null,2),{mode:0o600});
  await db.query(mode==='apply'?'commit':'rollback');
  console.log(JSON.stringify({mode,results:results.map(({id,name,start,end})=>({id,name,start,end})),testUnchanged:true}));
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
