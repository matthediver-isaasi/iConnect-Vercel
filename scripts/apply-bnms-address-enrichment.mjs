// Owner-approved follow-up CSV; distinct from the earlier invoicing-address copy.
// Fills only the 373 reviewed blanks. Never changes invoicing addresses or calls providers.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {connectDestination} from './lib/member-index-destination.mjs';
import {keys} from './bnms-address-mapping.mjs';

const mode=process.argv[2];
assert.ok(['dry-run','apply','verify'].includes(mode));
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const source='attached_assets/bnms_organisation_addresses_enriched_(1)_1792051420856.csv';
const original='private/bnms-address-audit/organisations-for-manual-address-entry.csv';
const hashes=[
  'db6eaffab587bc78efab882b31ea5df0aa2064494498b6401711951382261a46',
  '23a985e4973ba6885665de683a9c9b7ba227fbbde5bde082470da787f6fa6104',
];
for(const [i,path] of [source,original].entries()){
  assert.equal(createHash('sha256').update(fs.readFileSync(path)).digest('hex'),hashes[i],'Input changed');
}
const [enriched,baseline]=JSON.parse(execFileSync('python',['-c',`
import csv,json,sys
result=[]
for p in sys.argv[1:]:
    with open(p,encoding='utf-8-sig',newline='') as f:
        result.append(list(csv.DictReader(f)))
print(json.dumps(result))
`,source,original],{encoding:'utf8'}));
assert.equal(enriched.length,262);assert.equal(baseline.length,262);
const byId=new Map(baseline.map(r=>[r['Organisation ID'],r]));
assert.equal(byId.size,262);assert.equal(new Set(enriched.map(r=>r['Organisation ID'])).size,262);
assert.deepEqual([...byId.keys()].sort(),enriched.map(r=>r['Organisation ID']).sort());
const labels=['Address line 1','Address line 2','Address line 3','Town/city','County','Postcode','Country'];
const proposals=[];
for(const row of enriched){
  const old=byId.get(row['Organisation ID']);
  assert.equal(row['Organisation Name'],old['Organisation Name']);
  for(const [i,label] of labels.entries()){
    const value=row[label];
    assert.equal(typeof value,'string');
    if(value===old[label])continue;
    assert.equal(old[label].trim(),'','Not a blank-only enrichment');
    assert.ok(value.trim(),'Enrichment cannot clear a field');
    assert.ok(['Verified public listing','Suggested – check before import'].includes(row['Address research status']));
    proposals.push({organization_id:row['Organisation ID'],name:row['Organisation Name'],
      field_name:keys[i],label,value,researchStatus:row['Address research status'],
      researchSource:row['Research source'],researchNotes:row['Research notes']});
  }
}
assert.equal(proposals.length,373);assert.equal(new Set(proposals.map(p=>p.organization_id)).size,153);
const dir='private/bnms-address-audit/enrichment';
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const save=(name,data)=>fs.writeFileSync(`${dir}/${name}.json`,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});
const receiptPath=`${dir}/receipt.json`;
const db=await connectDestination();
const read=async()=>({
  fields:(await db.query(`select id,tenant_id,name,label,entity_scope,is_active,field_type from preference_field
    where tenant_id=$1 and name=any($2::text[]) order by id`,[tenant,keys])).rows,
  organizations:(await db.query(`select id,tenant_id,name,invoicing_address from organization where tenant_id=$1 order by id`,[tenant])).rows,
  values:(await db.query(`select v.id,v.organization_id,v.field_id,v.value from organization_preference_value v
    join organization o on o.id=v.organization_id join preference_field f on f.id=v.field_id
    where o.tenant_id=$1 and f.tenant_id=$1 and f.name=any($2::text[]) order by v.id`,[tenant,keys])).rows,
});
const pair=v=>`${v.organization_id}/${v.field_id}`;
try{
  if(mode==='verify'){
    const receipt=JSON.parse(fs.readFileSync(receiptPath));
    await db.query('BEGIN READ ONLY');
    assert.deepEqual(await read(),receipt.after,'Post-commit state differs from verified transaction');
    await db.query('ROLLBACK');
    console.log(JSON.stringify({mode,organizations:153,fields:373,postCommitVerified:true,providerWrites:0}));
  }else{
    assert.ok(!fs.existsSync(receiptPath),'Already applied; use verify instead');
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    // Prevent both edits and inserts into absent value pairs for this short transaction.
    await db.query('LOCK TABLE organization, preference_field, organization_preference_value IN SHARE ROW EXCLUSIVE MODE');
    const before=await read();
    assert.equal(before.fields.length,7);
    for(const [i,key] of keys.entries()){
      const matches=before.fields.filter(f=>f.name===key);
      assert.equal(matches.length,1);assert.equal(matches[0].label,labels[i]);
      assert.equal(matches[0].entity_scope,'organization');assert.equal(matches[0].is_active,true);
    }
    const plan=proposals.map(p=>{
      const org=before.organizations.find(o=>o.id===p.organization_id);
      assert.ok(org,'Organisation is not in BNMS');
      // The approved file and original export have identical pinned UUIDs and
      // names. Some existing rows now have a blank name: UUID still identifies
      // the same organisation. Preserve that blank, never restore names here.
      assert.ok(!String(org.name||'').trim() || org.name===p.name,'Organisation was renamed; review required');
      const field=before.fields.find(f=>f.name===p.field_name);
      assert.equal(field.field_type,'text');
      const existing=before.values.filter(v=>v.organization_id===org.id&&v.field_id===field.id);
      assert.ok(existing.length<=1,'Duplicate value pair');
      assert.equal(String(existing[0]?.value??'').trim(),'','Field changed since original export');
      return {...p,field_id:field.id};
    });
    assert.equal(new Set(before.values.map(pair)).size,before.values.length);
    if(mode==='apply'){
      const dry=JSON.parse(fs.readFileSync(`${dir}/dry-run.json`));
      assert.ok(Date.now()-dry.at<1800000,'Fresh dry run required');
      assert.deepEqual(dry.before,before,'State changed since dry run');
      assert.deepEqual(dry.plan,plan);
    }
    const audit={at:Date.now(),tenant,hashes,before,plan,
      authority:'Owner approved applying this enrichment, including Suggested entries; suggestions are not independently verified.',
      scope:'Blank-only organisation address custom fields; invoicing addresses and names unchanged',
      blankNamedOrganizations:before.organizations.filter(o=>!String(o.name||'').trim()
        && plan.some(p=>p.organization_id===o.id)).map(o=>o.id)};
    save(`${mode}-before-${Date.now()}`,audit);
    const result=await db.query(`insert into organization_preference_value (organization_id,field_id,value)
      select organization_id,field_id,value from jsonb_to_recordset($1::jsonb)
      as p(organization_id uuid,field_id uuid,value text)
      on conflict (organization_id,field_id) do update set value=excluded.value,updated_at=now()
      where organization_preference_value.value is null or btrim(organization_preference_value.value)=''
      returning id,organization_id,field_id,value`,[JSON.stringify(plan)]);
    assert.equal(result.rowCount,373);
    const after=await read();
    assert.deepEqual(after.fields,before.fields);assert.deepEqual(after.organizations,before.organizations);
    const planned=new Map(plan.map(p=>[pair(p),p.value]));
    const afterMap=new Map(after.values.map(v=>[pair(v),v]));
    assert.equal(afterMap.size,after.values.length);
    for(const v of before.values){
      assert.deepEqual(afterMap.get(pair(v)),planned.has(pair(v))?{...v,value:planned.get(pair(v))}:v);
    }
    for(const p of plan)assert.equal(afterMap.get(pair(p))?.value,p.value);
    const oldPairs=new Set(before.values.map(pair));
    assert.equal(after.values.length,before.values.length+plan.filter(p=>!oldPairs.has(pair(p))).length);
    save(`${mode}-precommit-${Date.now()}`,{...audit,after,changed:result.rows});
    await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
    if(mode==='dry-run')save('dry-run',audit);
    else save('receipt',{...audit,after,changed:result.rows,committedAt:new Date().toISOString()});
    console.log(JSON.stringify({mode,organizations:153,fields:373,committed:mode==='apply',
      preservedOtherValues:true,invoicingAddressesUnchanged:true,
      blankNamesPreserved:audit.blankNamedOrganizations.length,providerWrites:0}));
  }
}catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{await db.end();}
