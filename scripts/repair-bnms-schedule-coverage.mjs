// Approved schedule coverage only; never touches member terms or providers.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {connectDestination} from './lib/member-index-destination.mjs';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const dir='generated-artifacts/bnms-schedule-coverage';
const path=`${dir}/approved-plan.json`;
const start='2026-01-01';
const apply=process.argv.includes('--apply');
assert(process.argv.slice(2).every(x=>x==='--apply'));
const scope=r=>JSON.stringify([r.structure_scope_type,r.structure_field_id,r.structure_match_value.trim().toLowerCase()]);
function grouped(rows){
  const groups=new Map();
  for(const row of rows){const key=scope(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  return groups;
}
function verify(rows){
  const groups=grouped(rows);
  assert.equal(groups.size,15);
  for(const [key,versions] of groups){
    versions.sort((a,b)=>a.effective_from.localeCompare(b.effective_from));
    assert.equal(versions[0].effective_from,start,key);
    for(let i=1;i<versions.length;i++){
      assert(versions[i-1].effective_to,`Open-ended overlap: ${key}`);
      assert.equal(new Date(Date.parse(versions[i-1].effective_to)+86400000).toISOString().slice(0,10),versions[i].effective_from,key);
    }
    assert.equal(versions.at(-1).effective_to,null,key);
  }
}
const c=await connectDestination();
try{
  await c.query(apply?'BEGIN ISOLATION LEVEL SERIALIZABLE':'BEGIN READ ONLY');
  await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  if(apply)await c.query('LOCK TABLE membership_tier_config IN SHARE ROW EXCLUSIVE MODE');
  const rows=(await c.query('SELECT to_jsonb(t) r FROM membership_tier_config t WHERE tenant_id=$1 ORDER BY id',[tenant])).rows.map(x=>x.r);
  const children={};
  const full='b59692c9-07b0-469d-9f6e-9d314a270926';
  for(const table of ['membership_tier_band','membership_tier_discount','membership_tier_reminder']){
    children[table]=(await c.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 AND config_id=$2`,[tenant,full])).rows[0].n;
    assert.equal(children[table],0,'Do not omit dependent settings when copying Full schedule');
  }
  if(!apply){
    assert.equal(rows.length,16);
    assert(rows.every(r=>r.is_active===true&&r.structure_scope_type==='member'&&r.start_mode==='immediate'&&r.billing_period==='annual'&&r.pricing_model==='flat'));
    const updates=[],inserts=[];
    for(const versions of grouped(rows).values()){
      versions.sort((a,b)=>a.effective_from.localeCompare(b.effective_from));
      assert(versions[0].effective_from>start);
      if(versions.length===1)updates.push({id:versions[0].id,effective_from:start});
      else{
        assert.equal(versions.length,2);
        assert.equal(versions[1].id,full);
        assert.equal(versions[0].effective_from,'2026-07-29');
        assert.equal(versions[0].effective_to,'2026-08-31');
        assert.equal(versions[1].effective_from,'2026-09-01');
        const now=new Date().toISOString();
        inserts.push({...versions[1],id:randomUUID(),effective_from:start,effective_to:'2026-07-28',created_at:now,updated_at:now});
      }
    }
    const expected=rows.map(r=>updates.some(u=>u.id===r.id)?{...r,effective_from:start}:r).concat(inserts);
    verify(expected);
    assert.equal(updates.length,14);assert.equal(inserts.length,1);
    await mkdir(dir,{recursive:true});
    await writeFile(path,JSON.stringify({tenant,authority:'User approved continuous non-overlapping BNMS schedule coverage from 1 January 2026, preserving existing prices and versions; no member term or payment changes.',before:rows,updates,inserts,children},null,2),{mode:0o600});
    await c.query('ROLLBACK');
    console.log(JSON.stringify({mode:'dry-run',classes:15,updates:14,newBoundedFullVersion:1,overlaps:0,gaps:0}));
  }else{
    const plan=JSON.parse(await readFile(path,'utf8'));
    assert.equal(plan.tenant,tenant);assert.deepEqual(rows,plan.before);assert.deepEqual(children,plan.children);
    assert.equal(plan.updates.length,14);assert.equal(plan.inserts.length,1);
    for(const u of plan.updates){
      assert.equal(u.effective_from,start);
      assert.equal((await c.query('UPDATE membership_tier_config SET effective_from=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',[tenant,u.id,start])).rowCount,1);
    }
    for(const row of plan.inserts){
      assert.equal(row.tenant_id,tenant);
      await c.query('INSERT INTO membership_tier_config SELECT * FROM jsonb_populate_record(NULL::membership_tier_config,$1::jsonb)',[JSON.stringify(row)]);
    }
    const after=(await c.query('SELECT to_jsonb(t) r FROM membership_tier_config t WHERE tenant_id=$1 ORDER BY id',[tenant])).rows.map(x=>x.r);
    verify(after);assert.equal(after.length,17);
    for(const original of rows){
      const actual=after.find(r=>r.id===original.id);
      const expected={...original};
      if(plan.updates.some(u=>u.id===original.id)){expected.effective_from=start;expected.updated_at=actual.updated_at;}
      assert.deepEqual(actual,expected,'Only approved effective start dates may change');
    }
    const copy=after.find(r=>r.id===plan.inserts[0].id),source=rows.find(r=>r.id===full);
    for(const key of Object.keys(source)){
      if(!['id','effective_from','effective_to','created_at','updated_at'].includes(key))assert.deepEqual(copy[key],source[key],key);
    }
    await writeFile(`${dir}/applied.json`,JSON.stringify({committed:false,before:rows,after},null,2),{mode:0o600});
    await c.query('COMMIT');
    await writeFile(`${dir}/applied.json`,JSON.stringify({committed:true,before:rows,after},null,2),{mode:0o600});
    console.log(JSON.stringify({committed:true,classes:15,updated:14,inserted:1,overlaps:0,gaps:0}));
  }
}catch(e){await c.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally{await c.end();}
