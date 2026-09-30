import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const file = 'supabase/migrations/20261116_membership_incentive_snapshot.sql';
const sql = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(JSON.stringify({ file, sql })).digest('hex');
const tables = ['member_membership_history', 'organisation_membership_history'];
const evidenceFunction = 'protect_membership_incentive_snapshot';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function inspect(client, applied = false) {
  const functionDefaults = (await client.query(`SELECT defaclnamespace::regnamespace::text schema,
    defaclacl::text acl FROM pg_default_acl WHERE defaclrole=current_user::regrole
    AND defaclobjtype='f' AND (defaclnamespace=0 OR defaclnamespace='public'::regnamespace)
    ORDER BY defaclnamespace`)).rows;
  const security = (await client.query(`SELECT relname,relkind,relrowsecurity,relforcerowsecurity,relacl,
    pg_get_userbyid(relowner) owner FROM pg_class WHERE relnamespace='public'::regnamespace
    AND relname=ANY($1) ORDER BY relname`, [tables])).rows;
  if (security.length !== 2 || security.some(row => row.relkind !== 'r')) throw new Error('Unexpected history tables');
  const policies = (await client.query(`SELECT * FROM pg_policies WHERE schemaname='public'
    AND tablename=ANY($1) ORDER BY tablename,policyname`, [tables])).rows;
  const constraints = (await client.query(`SELECT conrelid::regclass::text table_name,conname,convalidated,
    pg_get_constraintdef(oid) definition FROM pg_constraint
    WHERE conrelid=ANY($1::regclass[]) ORDER BY conrelid,conname`, [tables.map(t => `public.${t}`)])).rows;
  for (const table of tables) {
    if (!constraints.some(c => c.conname === `${table}_rolling_complete_check` && c.convalidated
        && c.definition.includes('commitment_snapshot'))) throw new Error('Unexpected rolling completeness contract');
  }
  const triggers = (await client.query(`SELECT tgrelid::regclass::text table_name,tgname,tgenabled,
    pg_get_triggerdef(oid) definition FROM pg_trigger WHERE NOT tgisinternal
    AND tgrelid=ANY($1::regclass[]) ORDER BY tgrelid,tgname`, [tables.map(t => `public.${t}`)])).rows;
  const columns = (await client.query(`SELECT table_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1)
    AND column_name='incentive_snapshot' ORDER BY table_name`, [tables])).rows;
  const routines = (await client.query(`SELECT prosrc,prosecdef,proconfig,proacl,
    has_function_privilege('service_role',oid,'EXECUTE') service_execute,
    has_function_privilege('anon',oid,'EXECUTE') anon_execute,
    has_function_privilege('authenticated',oid,'EXECUTE') authenticated_execute,
    EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0) public_access
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1`, [evidenceFunction])).rows;
  const ownTriggers = triggers.filter(t => t.tgname === evidenceFunction);
  if (!applied) {
    if (columns.length || routines.length || ownTriggers.length) throw new Error('Existing incentive objects require separate review; nothing overwritten');
  } else {
    if (columns.length !== 2 || columns.some(c => c.data_type !== 'jsonb' || c.is_nullable !== 'YES' || c.column_default !== null)) {
      throw new Error('Unexpected installed incentive column definition');
    }
    const expectedBody = sql.match(/AS \$\$([\s\S]*?)\$\$;/)?.[1].trim();
    const routine = routines[0];
    if (routines.length !== 1 || routine.prosrc.trim() !== expectedBody || routine.prosecdef
        || JSON.stringify(routine.proconfig) !== JSON.stringify(['search_path=pg_catalog'])
        || routine.public_access || routine.anon_execute || routine.authenticated_execute || routine.service_execute) {
      throw new Error('Unexpected installed incentive trigger function/security');
    }
    if (ownTriggers.length !== 2 || ownTriggers.some(t => t.tgenabled !== 'O'
        || !t.definition.includes('BEFORE UPDATE') || !/EXECUTE FUNCTION (public\.)?protect_membership_incentive_snapshot\(\)/.test(t.definition))) {
      throw new Error('Unexpected installed incentive trigger binding');
    }
  }
  return {
    invariant: digest({ security, policies, constraints, triggers: triggers.filter(t => t.tgname !== evidenceFunction) }),
    constraints: constraints.map(c => ({ name: c.conname, validated: c.convalidated })),
    security: { tables: security.length, policies: policies.length, sha256: digest({ security, policies }) },
    columns, immutableTriggers: ownTriggers.length,
    functionAcl: routines[0] ? { serviceExecute: routines[0].service_execute,
      anonExecute: routines[0].anon_execute, authenticatedExecute: routines[0].authenticated_execute,
      publicAccess: routines[0].public_access, securityDefiner: routines[0].prosecdef } : null,
    functionDefaults,
  };
}
async function financialSnapshot(client) {
  const result = {};
  // SELECT-only evidence. No row contents or identifying financial values are logged.
  for (const table of [...tables, 'membership_billing_agreements', 'membership_payment_plans',
    'gocardless_collection_reservations', 'gocardless_payments']) {
    result[table] = (await client.query(`SELECT count(*)::integer count,
      md5(coalesce(string_agg(md5((to_jsonb(r)-'incentive_snapshot')::text),'' ORDER BY r.id),'')) digest
      FROM public.${table} r`)).rows[0];
  }
  result.testOrganisationHistory = (await client.query(`SELECT count(*)::integer count
    FROM public.organisation_membership_history WHERE organization_id=$1`,
  ['165e4f9d-4727-4108-9bb9-4995d9705544'])).rows[0].count;
  if (result.testOrganisationHistory !== 0) throw new Error('Test organisation history changed; stop for review');
  return result;
}
if (!process.argv.includes('--apply') && !process.argv.includes('--preflight')) {
  console.log(JSON.stringify({ dryRun: true, file, sha256, writesPerformed: false }));
} else {
  if (!process.argv.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed migration hash required; no database changed.');
  if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL)) {
    throw new Error('Destination pin mismatch; no database changed.');
  }
  // Operator supplies the reviewed CA locally: no implicit external requests.
  if (!process.env.DEST_DATABASE_CA_FILE) throw new Error('Reviewed destination CA file required.');
  const ca = await readFile(process.env.DEST_DATABASE_CA_FILE, 'utf8');
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA');
  const url = new URL(process.env.DEST_DATABASE_URL);
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword']) url.searchParams.delete(key);
  const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true, ca, servername: url.hostname } });
  await client.connect();
  let committed = false;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='120s'");
    const preflight = await inspect(client);
    const before = await financialSnapshot(client);
    await client.query('ROLLBACK');
    if (process.argv.includes('--preflight')) {
      console.log(JSON.stringify({ preflight: true, destinationProject: 'lvmzliemqnieeoruhkik',
        file, sha256, writesPerformed: false, contract: preflight, financialSnapshot: before }));
    } else {
    if (preflight.functionDefaults.some(row => /(?:anon|authenticated|service_role)=/.test(row.acl))
        && !sql.includes('REVOKE ALL ON FUNCTION public.protect_membership_incentive_snapshot() FROM PUBLIC, anon, authenticated, service_role;')) {
      throw new Error('Destination default function grants are incompatible with reviewed owner-only trigger ACL; review an amended migration before applying');
    }
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
    // Do not overwrite objects that appeared between preflight and the DDL.
    await client.query('LOCK TABLE public.member_membership_history,public.organisation_membership_history IN ACCESS EXCLUSIVE MODE');
    const locked = await inspect(client);
    if (locked.invariant !== preflight.invariant) throw new Error('History contract changed after preflight');
    await client.query(sql);
    const verified = await inspect(client, true);
    if (verified.invariant !== preflight.invariant) throw new Error('Existing constraints, triggers or security changed');
    if (JSON.stringify(await financialSnapshot(client)) !== JSON.stringify(before)) throw new Error('Financial rows changed since preflight; rollback and review concurrency');
    await client.query('COMMIT');
    committed = true;
    await client.query('BEGIN READ ONLY');
    const afterContract = await inspect(client, true);
    const after = await financialSnapshot(client);
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ applied: true, destinationProject: 'lvmzliemqnieeoruhkik', file, sha256,
      contract: afterContract, financialSnapshot: after, financialSnapshotUnchanged: JSON.stringify(after) === JSON.stringify(before),
      existingContractUnchanged: afterContract.invariant === preflight.invariant }));
    }
  } catch (error) {
    await client.query('ROLLBACK');
    if (committed) console.error('Migration committed; post-commit verification failed. Do not reapply.');
    throw error;
  } finally { await client.end(); }
}