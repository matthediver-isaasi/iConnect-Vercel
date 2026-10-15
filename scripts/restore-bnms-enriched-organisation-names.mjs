// Owner-approved restoration of the 14 blank names identified in the enrichment receipt.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {connectDestination} from './lib/member-index-destination.mjs';
const mode=process.argv[2];
assert.ok(['dry-run','apply','verify'].includes(mode));
const dir='private/bnms-address-audit/enrichment';
const receipt=JSON.parse(fs.readFileSync(`${dir}/receipt.json`));
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
assert.equal(receipt.tenant,tenant);
const plan=receipt.blankNamedOrganizations.map(id=>{
  const names=[...new Set(receipt.plan.filter(p=>p.organization_id===id).map(p=>p.name))];
  assert.equal(names.length,1);assert.ok(names[0]?.trim());
  const original=receipt.before.organizations.find(o=>o.id===id);
  assert.ok(original);assert.equal(original.tenant_id,tenant);assert.equal(original.name,'');
  return {id,name:names[0]};
}).sort((a,b)=>a.id.localeCompare(b.id));
assert.equal(plan.length,14);assert.equal(new Set(plan.map(p=>p.id)).size,14);
const ids=plan.map(p=>p.id);
const save=(name,value)=>fs.writeFileSync(`${dir}/${name}.json`,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
const db=await connectDestination();
const read=async()=>({
  organizations:(await db.query(`select to_jsonb(o) data from organization o where tenant_id=$1 and id=any($2::uuid[]) order by id`,[tenant,ids])).rows.map(r=>r.data),
  addresses:(await db.query(`select to_jsonb(v) data from organization_preference_value v where organization_id=any($1::uuid[]) order by id`,[ids])).rows.map(r=>r.data),
});
try{
  if(mode==='verify'){
    await db.query('BEGIN READ ONLY');
    const applied=JSON.parse(fs.readFileSync(`${dir}/names-receipt.json`));
    assert.deepEqual(await read(),applied.after);
    await db.query('ROLLBACK');
    console.log(JSON.stringify({mode,restored:14,postCommitVerified:true}));
  }else{
    assert.ok(!fs.existsSync(`${dir}/names-receipt.json`),'Already applied; use verify');
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    const locked=await db.query('select id from organization where tenant_id=$1 and id=any($2::uuid[]) order by id for update',[tenant,ids]);
    assert.equal(locked.rowCount,14);
    const before=await read();
    for(const o of before.organizations)assert.equal(o.name,'','Name changed; do not overwrite');
    if(mode==='apply'){
      const dry=JSON.parse(fs.readFileSync(`${dir}/names-dry-run.json`));
      assert.ok(Date.now()-dry.at<1800000);assert.deepEqual(dry.before,before);assert.deepEqual(dry.plan,plan);
    }
    const audit={at:Date.now(),tenant,before,plan,authority:'Owner authorised restoring these 14 organisation names from the original export.'};
    save(`names-${mode}-before-${Date.now()}`,audit);
    const result=await db.query(`update organization o set name=p.name,updated_at=now()
      from jsonb_to_recordset($1::jsonb) as p(id uuid,name text)
      where o.id=p.id and o.tenant_id=$2 and o.name='' returning o.id`,[JSON.stringify(plan),tenant]);
    assert.equal(result.rowCount,14);
    const after=await read();
    assert.deepEqual(after.addresses,before.addresses);
    const stable=o=>{const {updated_at,...rest}=o;return rest};
    assert.equal(after.organizations.length,14);
    for(const o of after.organizations){
      const old=before.organizations.find(v=>v.id===o.id);
      assert.deepEqual(stable(o),{...stable(old),name:plan.find(p=>p.id===o.id).name});
    }
    save(`names-${mode}-precommit-${Date.now()}`,{...audit,after});
    await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
    save(mode==='apply'?'names-receipt':'names-dry-run',{...audit,after});
    console.log(JSON.stringify({mode,restored:14,committed:mode==='apply',addressesUnchanged:true,otherOrganisationDetailsUnchanged:true}));
  }
}catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{await db.end()}
