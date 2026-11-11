import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {connectDestination,PROJECT} from './lib/member-index-destination.mjs';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const source='a8e264fd-5e9e-4ff4-ac0b-85e800e324be';
const target='547c643c-bfb8-4d96-bb97-77a42eadcedb';
const rule={id:'887ec46b-f7b0-4ee0-96d3-364e7aa11537',matchType:'membership_class',roleId:null,
 fieldId:'87f120ff-92e6-4d52-944b-9ba9d7b1fac0',classValue:'Retired',route:'same_schedule',formId:target,restrictToClass:true};
const file='supabase/migrations/202701220003_membership_renewal_exceptions.sql';
const root='generated-artifacts/bnms-retired-renewal-exception';
const mode=process.argv[2];assert(['inspect','rehearse','apply'].includes(mode));
const sql=(await Promise.all([file,'supabase/migrations/202701220004_renewal_exception_existing_checkout.sql']
 .map(async name=>(await readFile(name,'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
 .replace(/\nBEGIN;\s*/,'\n')))).join('\n');
const db=await connectDestination();
try{
 await db.query(mode==='inspect'?'begin read only':'begin isolation level serializable');
 await db.query("set local lock_timeout='5s';set local statement_timeout='30s'");
 const original=(await db.query(`select to_jsonb(f) row from form f where tenant_id=$1 and id=$2 ${mode==='inspect'?'':'for update'}`,[tenant,source])).rows[0]?.row;
 assert(original?.archived_at && !original.is_active);
 assert.equal(original.fields.length,1);assert.equal(original.fields[0].type,'membership_payment');
 assert.deepEqual(original.entity_pipelines,{members:[],organisations:[]});
 assert.equal((await db.query('select id from form where tenant_id=$1 and (id=$2 or slug=$3)',[tenant,target,'direct-membership-renewal'])).rowCount,0);
 const defaults=(await db.query('select to_jsonb(s) row from membership_renewal_journey s where tenant_id=$1',[tenant])).rows[0].row;
 const form={...original,id:target,name:'Direct membership renewal',slug:'direct-membership-renewal',
   is_active:true,require_authentication:true,archived_at:null,deactivate_at:null,submission_count:0,
   mutation_access_policy:{version:1,mode:'authenticated_owner'}};
 for(const k of ['created_date','updated_date'])if(k in form)form[k]=new Date().toISOString().slice(0,10)+'T00:00:00+00:00';
 const digest=createHash('sha256').update(JSON.stringify({sql,original,defaults,form,rule})).digest('hex');
 if(mode==='apply'){
   const review=JSON.parse(await readFile(`${root}/rehearse.json`,'utf8'));
   assert.equal(review.digest,digest,'Reviewed configuration changed');
   assert(process.argv.includes(`--review-sha256=${digest}`),'Reviewed fingerprint required');
 }
 if(mode!=='inspect'){
   await db.query(sql.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
   const columns=Object.keys(form);assert(columns.every(k=>/^[a-z_]+$/.test(k)));
   const names=columns.map(k=>`"${k}"`).join(',');
   await db.query(`insert into form(${names}) select ${names} from jsonb_populate_record(null::form,$1::jsonb)`,[JSON.stringify(form)]);
   await db.query('set local role service_role');
   const saved=(await db.query('select save_membership_renewal_exceptions($1,$2,0,$3) row',[tenant,'owner-approved:retired-renewal',JSON.stringify([rule])])).rows[0].row;
   assert.deepEqual(saved.rules,[rule]);await db.query('reset role');
   assert.deepEqual((await db.query('select to_jsonb(f) row from form f where id=$1',[source])).rows[0].row,original);
   assert.deepEqual((await db.query('select to_jsonb(s) row from membership_renewal_journey s where tenant_id=$1',[tenant])).rows[0].row,defaults);
   const copy=(await db.query('select to_jsonb(f) row from form f where id=$1',[target])).rows[0].row;
   assert.deepEqual(copy.fields,original.fields);assert.equal(copy.require_authentication,true);
   const grants=(await db.query(`select has_function_privilege('anon','save_membership_renewal_exceptions(uuid,text,bigint,jsonb)','execute') anon,
     has_function_privilege('authenticated','save_membership_renewal_exceptions(uuid,text,bigint,jsonb)','execute') authenticated,
     has_function_privilege('service_role','save_membership_renewal_exceptions(uuid,text,bigint,jsonb)','execute') service`)).rows[0];
   assert.deepEqual(grants,{anon:false,authenticated:false,service:true});
 }
 await mkdir(root,{recursive:true,mode:0o700});
 await writeFile(`${root}/${mode}.json`,JSON.stringify({digest,project:PROJECT,original,defaults,form,rule},null,2),{mode:0o600});
 await db.query(mode==='apply'?'commit':'rollback');
 console.log(JSON.stringify({mode,digest,project:PROJECT,newFormId:target,defaultUnchanged:true,liveChanges:mode==='apply'}));
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
