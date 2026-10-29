// Approved, pinned DEST deployment. Schema only; no checkout/account invocation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {connectDestination,PROJECT} from './annual-meeting-destination.mjs';
const paths=['supabase/migrations/202612090005_event_registration_associations.sql',
  'supabase/migrations/202612090006_event_registration_association_accounts.sql'];
const files=await Promise.all(paths.map(async path=>({path,sql:await readFile(path,'utf8')})));
const digest=createHash('sha256').update(files.map(f=>`${f.path}\n${f.sql}`).join('\n')).digest('hex');
const args=process.argv.slice(2);
if(!args.includes('--apply')){
  console.log(JSON.stringify({destination:PROJECT,migrations:paths,digest,writesPerformed:false}));
  process.exit(0);
}
assert.deepEqual(args.sort(),['--apply',`--review-sha256=${digest}`].sort());
const db=await connectDestination();
const signatures=[
  'public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid)',
  'public.registration_association_value_matches(text,text)',
  'public.assert_registration_account_association(uuid,jsonb)',
  'public.provision_public_ticket_members(uuid)',
  'public.insert_public_ticket_booking_batch(uuid,jsonb)',
];
let committed=false;
try{
  await db.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('registration-association-schema',0))");
  const before=(await db.query(`SELECT current_database()='postgres' AS destination_database,
    NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('event','complex_event') AND column_name='registration_association_config') AS unapplied,
    to_regprocedure('public.provision_public_ticket_members(uuid)') IS NOT NULL AS provisioning_exists,
    to_regprocedure('public.insert_public_ticket_booking_batch(uuid,jsonb)') IS NOT NULL AS batch_exists`)).rows[0];
  assert.ok(Object.values(before).every(Boolean),'Prerequisite or unapplied-state check failed');
  const original=(await db.query(`SELECT oid::text,proacl::text,prosecdef,proconfig FROM pg_proc
    WHERE oid IN ($1::regprocedure,$2::regprocedure) ORDER BY oid`,signatures.slice(-2))).rows;
  for(const file of files){
    assert.match(file.sql,/^BEGIN;/);assert.match(file.sql,/COMMIT;\s*$/);
    await db.query(file.sql.replace(/^BEGIN;/,'').replace(/COMMIT;\s*$/,''));
  }
  const after=(await db.query(`SELECT oid::text,proacl::text,prosecdef,proconfig FROM pg_proc
    WHERE oid IN ($1::regprocedure,$2::regprocedure) ORDER BY oid`,signatures.slice(-2))).rows;
  assert.deepEqual(after,original,'Existing function permissions or execution context changed');
  for(const signature of signatures){
    const permissions=(await db.query(`SELECT
      NOT has_function_privilege('anon',$1,'EXECUTE') AS anonymous_denied,
      NOT has_function_privilege('authenticated',$1,'EXECUTE') AS browser_denied,
      has_function_privilege('service_role',$1,'EXECUTE') AS server_allowed`,[signature])).rows[0];
    assert.ok(Object.values(permissions).every(Boolean),'Function protection failed');
  }
  const checks=(await db.query(`SELECT
    (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('event','complex_event') AND column_name='registration_association_config'
      AND data_type='jsonb' AND column_default IS NULL) AS settings_default_off,
    NOT EXISTS(SELECT 1 FROM public.event WHERE registration_association_config IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM public.complex_event WHERE registration_association_config IS NOT NULL) AS no_events_enabled,
    (SELECT count(*)=2 FROM pg_trigger WHERE tgfoid='public.guard_registration_association_config()'::regprocedure
      AND tgrelid IN ('public.event'::regclass,'public.complex_event'::regclass) AND tgenabled='O') AS browser_write_guards,
    (SELECT NOT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc
      WHERE oid='public.guard_registration_association_config()'::regprocedure) AS invoker_guard_pinned,
    position('assert_registration_account_association' in pg_get_functiondef('public.provision_public_ticket_members(uuid)'::regprocedure))>0 AS association_provisioning,
    position('association_role_id' in pg_get_functiondef('public.insert_public_ticket_booking_batch(uuid,jsonb)'::regprocedure))>0 AS explicit_unpaid_guard`)).rows[0];
  assert.ok(Object.values(checks).every(Boolean),'Schema verification failed');
  for(const role of ['anon','authenticated']){
    await db.query(`SET LOCAL ROLE ${role}`);
    for(const sql of [
      'SELECT public.event_registration_association_options(NULL,NULL,NULL)',
      'SELECT public.assert_registration_account_association(NULL,NULL)',
      'SELECT public.provision_public_ticket_members(NULL)',
      'SELECT public.insert_public_ticket_booking_batch(NULL,NULL)',
    ]){
      await db.query('SAVEPOINT denied_call');
      let code;
      try{await db.query(sql);}catch(error){code=error.code;}
      await db.query('ROLLBACK TO SAVEPOINT denied_call');
      assert.equal(code,'42501','Expected execution denial');
    }
    await db.query('RESET ROLE');
  }
  await db.query("NOTIFY pgrst,'reload schema'; COMMIT");
  committed=true;
  console.log(JSON.stringify({applied:true,destination:PROJECT,digest,migrations:paths,checks,
    roleExecutionDenialsVerified:true,existingFunctionPermissionsPreserved:true,businessOperationsPerformed:false},null,2));
}catch(error){
  await db.query('ROLLBACK').catch(()=>{});
  console.error(JSON.stringify({applied:committed,error:error.message,code:error.code||null}));
  process.exitCode=1;
}finally{await db.end();}
