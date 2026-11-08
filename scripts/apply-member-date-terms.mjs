import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
const paths = ['supabase/migrations/202612310090_member_date_terms.sql','supabase/migrations/202612310091_form_member_date_terms.sql'];
const sql = paths.map(path => readFileSync(path,'utf8'));
const hash = createHash('sha256').update(sql.join('\n')).digest('hex');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({target:PROJECT,migrations:paths,sha256:hash,applied:false}));
  process.exit(0);
}
assert.equal(process.argv[process.argv.indexOf('--sha256')+1],hash,'Reviewed migration hash required');
const db = await connectDestination();
try {
  await db.query('begin');
  await db.query("set local lock_timeout='5s'; set local statement_timeout='30s'");
  await db.query('lock table membership_tier_config,member_membership_history,form,form_submission in share mode');
  const fingerprint = async () => {
    const result = {};
    for (const table of ['membership_tier_config','member_membership_history','form']) {
      result[table] = (await db.query(`select count(*)::text n,md5(coalesce(string_agg((to_jsonb(t)-'term_end_mode'-'term_end_field_id'-'term_source_snapshot'-'date_membership_config_id')::text,'' order by id),'')) hash from ${table} t`)).rows[0];
    }
    return result;
  };
  const before=await fingerprint();
  for(const text of sql) await db.query(text.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
  assert.deepEqual(await fingerprint(),before,'Existing configuration or history changed');
  const privileges=(await db.query(`select
    has_function_privilege('authenticated','public.extend_member_date_term(uuid,uuid,uuid,date,date,text,text)','execute') auth_execute,
    has_function_privilege('anon','public.extend_member_date_term(uuid,uuid,uuid,date,date,text,text)','execute') anon_execute,
    has_function_privilege('service_role','public.extend_member_date_term(uuid,uuid,uuid,date,date,text,text)','execute') service_execute`)).rows[0];
  assert.deepEqual(privileges,{auth_execute:false,anon_execute:false,service_execute:true});
  await db.query('commit');
  console.log(JSON.stringify({applied:true,target:PROJECT,sha256:hash,existingDataUnchanged:true,privileges}));
} catch(error) {
  await db.query('rollback');
  throw error;
} finally {await db.end();}
