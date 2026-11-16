// Explicit operator-approved, destination-pinned one-time policy update.
// Runs transactionally; never disables snapshot or date-policy protections.
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';

if (!process.argv.includes('--apply-approved')) throw new Error('Requires --apply-approved');
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const former='d536896d-b43a-4377-89ef-6c95f1496358';
const guest='b640bd84-3d84-4cde-9f27-c3e80edb762f';
const migration=await readFile(new URL('../supabase/migrations/202611162100_bnms_post_grace_guest_role.sql',import.meta.url),'utf8');
const directory='generated-artifacts/bnms-post-grace-role-policy';
await mkdir(directory,{recursive:true,mode:0o700});
const audit=`${directory}/protected-apply-${Date.now()}.jsonl`;
await writeFile(audit,JSON.stringify({stage:'started',tenant,former,guest})+'\n',{mode:0o600,flag:'wx'});
const record = data => appendFile(audit,JSON.stringify(data)+'\n');
const db=await connectDestination();
let committed=false;
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SET LOCAL statement_timeout='90s'");
  await db.query('LOCK TABLE public.membership_expiry_action IN SHARE ROW EXCLUSIVE MODE');
  const role=(await db.query('SELECT * FROM role WHERE tenant_id=$1 AND id=$2 FOR SHARE',[tenant,guest])).rows[0];
  assert.equal(role.name,'CPD Guest');
  assert.equal(role.is_admin,false); assert.equal(role.is_tenant_admin,false);
  assert.equal(role.max_members,null);
  assert.equal((await db.query(`SELECT count(*)::int n FROM membership_expiry_action
    WHERE tenant_id=$1 AND assigned_role_id=$2 AND action_state='pending'`,[tenant,former])).rows[0].n,0,
  'Pending legacy actions need separate reconciliation');
  const before=(await db.query('SELECT * FROM membership_tier_config WHERE tenant_id=$1 ORDER BY id FOR UPDATE',[tenant])).rows;
  assert.equal(before.length,18);
  assert(before.every(r=>r.renewal_change_role===true && r.renewal_fallback_role_id===former && r.structure_scope_type==='member'));
  await record({stage:'before-schedules',rows:before});

  const protectedTables=['member_membership_history','membership_expiry_policy_assignment',
    'membership_expiry_action','membership_billing_agreements','member'];
  const digest=async table=>{
    assert(protectedTables.includes(table));
    return (await db.query(`SELECT count(*)::int n,
      md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY id),'')) hash
      FROM public.${table} r WHERE tenant_id=$1`,[tenant])).rows[0];
  };
  const hashes={};
  for(const table of protectedTables)hashes[table]=await digest(table);
  const foreignDigest=async()=>(await db.query(`SELECT
    md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY id),'')) hash
    FROM membership_tier_config r WHERE tenant_id<>$1`,[tenant])).rows[0].hash;
  const foreignBefore=await foreignDigest();
  await db.query(migration);
  // This is the normal protected server role required by member-date schedules.
  await db.query('SET LOCAL ROLE service_role');
  const updated=await db.query(`UPDATE membership_tier_config
    SET renewal_fallback_role_id=$3,updated_at=now()
    WHERE tenant_id=$1 AND renewal_fallback_role_id=$2 AND renewal_change_role=true
    RETURNING id`,[tenant,former,guest]);
  assert.equal(updated.rowCount,18);
  await db.query('RESET ROLE');

  const verify=async()=>{
    const after=(await db.query('SELECT * FROM membership_tier_config WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
    assert.equal(after.length,18);
    after.forEach((r,i)=>{
      assert.equal(r.renewal_fallback_role_id,guest);
      assert.deepEqual({...r,renewal_fallback_role_id:before[i].renewal_fallback_role_id,updated_at:before[i].updated_at},before[i]);
    });
    const f=(await db.query(`SELECT oid,prosrc,prosecdef,proconfig,
      has_function_privilege('anon',oid,'EXECUTE') anon_exec,
      has_function_privilege('authenticated',oid,'EXECUTE') auth_exec
      FROM pg_proc WHERE oid='public.bnms_post_grace_guest_role()'::regprocedure`)).rows[0];
    assert.equal(f.prosrc.trim(),migration.split('AS $$')[1].split('END $$;')[0].concat('END').trim());
    assert.equal(f.prosecdef,true);
    assert.deepEqual(f.proconfig,['search_path=public, pg_temp']);
    assert.equal(f.anon_exec,false); assert.equal(f.auth_exec,false);
    assert.deepEqual((await db.query(`SELECT tgenabled,tgtype FROM pg_trigger
      WHERE tgrelid='public.membership_expiry_action'::regclass AND tgfoid=$1`,[f.oid])).rows,[{tgenabled:'O',tgtype:7}]);
  };
  await verify();
  for(const table of protectedTables)assert.deepEqual(await digest(table),hashes[table],`${table} must remain unchanged`);
  assert.equal(await foreignDigest(),foreignBefore);
  await db.query('COMMIT'); committed=true;
  await record({stage:'committed',schedules:18,protectedTables:hashes,at:new Date().toISOString()});
  await verify();
  await record({stage:'verified-after-commit'});
  console.log(JSON.stringify({scheduleVersionsUpdated:18,allScheduleFallbacks:'CPD Guest',
    graceAndLoginSettingsUnchanged:true,protectedSnapshotsAndPriorActionsUnchanged:true,
    otherTenantSchedulesUnchanged:true,futureLegacyFormerRoleRedirectInstalled:true,
    publicExecutionDenied:true,verifiedAfterCommit:true}));
} catch(error) {
  if(!committed)await db.query('ROLLBACK');
  await record({stage:committed?'verification-error-after-commit':'rolled-back',error:error.message});
  console.error(JSON.stringify({committed,error:error.message}));
  process.exitCode=1;
} finally {
  await db.end();
}
