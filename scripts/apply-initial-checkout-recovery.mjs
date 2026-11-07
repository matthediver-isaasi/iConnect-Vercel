import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
const file = 'supabase/migrations/202701210001_initial_checkout_recovery.sql';
const sql = readFileSync(file, 'utf8');
const sha = createHash('sha256').update(sql).digest('hex');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({file,sha,project:PROJECT,dryRun:true}));
} else {
  assert.ok(process.argv.includes(`--review-sha256=${sha}`), 'Exact reviewed migration hash required');
  const db=await connectDestination();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    assert.equal((await db.query("select to_regclass('public.form_initial_checkout_recovery') as existing")).rows[0].existing,null);
    await db.query(sql.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
    const checks=(await db.query(`select
      (select relrowsecurity from pg_class where oid='public.form_initial_checkout_recovery'::regclass) as rls,
      has_table_privilege('anon','public.form_initial_checkout_recovery','SELECT') as public_read,
      has_table_privilege('service_role','public.form_initial_checkout_recovery','INSERT') as direct_write,
      has_function_privilege('authenticated','public.begin_form_initial_checkout_recovery(uuid,uuid)','EXECUTE') as browser_execute,
      has_function_privilege('service_role','public.begin_form_initial_checkout_recovery(uuid,uuid)','EXECUTE') as service_execute,
      (select count(*)::int from pg_trigger where tgname='guard_initial_recovery' and tgenabled='O') as triggers`)).rows[0];
    assert.deepEqual(checks,{rls:true,public_read:false,direct_write:false,browser_execute:false,service_execute:true,triggers:4});
    assert.equal((await db.query('select count(*)::int as n from public.form_initial_checkout_recovery')).rows[0].n,0);
    await db.query('COMMIT');
    console.log(JSON.stringify({applied:true,project:PROJECT,sha,checks,checkoutsChanged:0}));
  }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
}
