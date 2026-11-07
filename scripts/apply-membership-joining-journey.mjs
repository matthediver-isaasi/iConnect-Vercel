import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
const file='supabase/migrations/202701210003_membership_joining_journey.sql';
const sql=readFileSync(file,'utf8'),sha=createHash('sha256').update(sql).digest('hex');
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',form='ab2d6278-686c-4604-be28-05d4bb328e03';
if(!process.argv.includes('--apply')) console.log(JSON.stringify({file,sha,project:PROJECT,dryRun:true}));
else {
 assert.ok(process.argv.includes(`--review-sha256=${sha}`),'Exact reviewed migration hash required');
 const db=await connectDestination();
 try {
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s'");
  const renewalBefore=(await db.query('select * from membership_renewal_journey where tenant_id=$1',[tenant])).rows;
  const formBefore=(await db.query('select id,tenant_id,name,slug,is_active,require_authentication,form_type from form where id=$1',[form])).rows;
  assert.equal(formBefore[0]?.tenant_id,tenant);
  assert.equal((await db.query("select to_regclass('public.membership_joining_journey') as existing")).rows[0].existing,null,'Already installed: inspect instead of overwriting');
  await db.query(sql.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
  const configured=(await db.query('select save_membership_joining_journey($1,$2,$3,$4) as setting',
    [tenant,'approved:first-membership-questionnaire-rollout',form,0])).rows[0].setting;
  assert.equal(configured.form_id,form);assert.equal(configured.revision,1);
  const protections=(await db.query(`select
    has_table_privilege('anon','membership_joining_journey','SELECT') as public_read,
    has_table_privilege('service_role','membership_joining_journey','UPDATE') as direct_update,
    has_function_privilege('authenticated','save_membership_joining_journey(uuid,text,uuid,bigint)','EXECUTE') as browser_save,
    has_function_privilege('service_role','save_membership_joining_journey(uuid,text,uuid,bigint)','EXECUTE') as service_save,
    (select count(*)::int from pg_class where oid in ('membership_joining_journey'::regclass,'membership_joining_journey_history'::regclass) and relrowsecurity) as rls_tables`)).rows[0];
  assert.deepEqual(protections,{public_read:false,direct_update:false,browser_save:false,service_save:true,rls_tables:2});
  assert.equal((await db.query('select count(*)::int as n from membership_joining_journey')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int as n from membership_joining_journey_history')).rows[0].n,1);
  assert.deepEqual((await db.query('select * from membership_renewal_journey where tenant_id=$1',[tenant])).rows,renewalBefore);
  assert.deepEqual((await db.query('select id,tenant_id,name,slug,is_active,require_authentication,form_type from form where id=$1',[form])).rows,formBefore);
  await db.query('COMMIT');
  console.log(JSON.stringify({applied:true,project:PROJECT,sha,protections,configuredTenant:tenant,entryForm:form,renewalUnchanged:true,formUnchanged:true,membershipsChanged:0}));
 }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
}
