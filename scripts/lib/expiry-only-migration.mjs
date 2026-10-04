import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isApprovedDestinationSupabaseTarget } from './destinationSupabaseTarget.mjs';
import { connectDestination } from './member-index-destination.mjs';

const migrationName = '20261206_bnms_expiry_only_form_renewal';
const sha = value => createHash('sha256').update(value).digest('hex');
const reservation = 'public.reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb)';
const policy = 'public.form_expiry_only_renewal_policy(jsonb,uuid,uuid)';
const capability = 'public.form_expiry_only_renewal_supported()';
const tables = [
  'member_membership_history', 'organisation_membership_history',
  'membership_expiry_policy_assignment', 'membership_successor_tenant_rollout',
  'membership_successor_rollout', 'membership_successor_election',
];
const names = [
  'reserve_membership_successor', 'membership_successor_elections_enabled',
  'guard_membership_expiry_policy_assignment', 'enforce_rolling_membership_commitment',
  'reserve_form_membership_payment_quote', 'bind_form_membership_payment_quote',
  'form_expiry_only_renewal_policy', 'form_expiry_only_renewal_supported',
];

export function validateExpiryOnlyArgs(args) {
  if (args.some(arg => !['--expiry-only', '--verify-dest', '--apply'].includes(arg)
    && !/^--expected-contract=[a-f0-9]{64}$/.test(arg)
    && !/^--expected-migration=[a-f0-9]{64}$/.test(arg))
    || new Set(args.map(arg => arg.split('=')[0])).size !== args.length
    || (args.includes('--apply') && args.includes('--verify-dest'))) {
    throw new Error('Refusing unsupported or ambiguous expiry-only arguments');
  }
  const expected = args.find(arg => arg.startsWith('--expected-contract='))?.split('=')[1];
  const expectedMigration = args.find(arg => arg.startsWith('--expected-migration='))?.split('=')[1];
  if (args.includes('--apply') && (!expected || !expectedMigration)) {
    throw new Error('Applying requires reviewed contract and migration hashes');
  }
  return { apply: args.includes('--apply'), verify: args.includes('--verify-dest'), expected, expectedMigration };
}

async function inspect(db) {
  const functions = (await db.query(`SELECT p.proname,
    pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS definition,
    p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1) ORDER BY p.proname,args`, [names])).rows;
  const metadata = (await db.query(`SELECT c.relname, c.relrowsecurity, c.relacl::text,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull)
      ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,
    (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname)
      FROM pg_constraint k WHERE k.conrelid=c.oid) constraints,
    (SELECT jsonb_agg(jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled) ORDER BY t.tgname)
      FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) triggers
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1) ORDER BY c.relname`, [tables])).rows;
  if (metadata.length !== tables.length) throw new Error('Refusing missing prerequisite tables');
  const assignment = metadata.find(row => row.relname === 'membership_expiry_policy_assignment');
  if (!assignment.relrowsecurity || !assignment.triggers?.some(([definition, enabled]) =>
    definition.includes('BEFORE INSERT OR DELETE OR UPDATE')
      && definition.includes('guard_membership_expiry_policy_assignment()') && ['O', 'A'].includes(enabled))) {
    throw new Error('Refusing missing immutable assignment guard or RLS');
  }
  const reserve = functions.filter(row => row.proname === 'reserve_membership_successor');
  if (reserve.length !== 1 || !reserve[0].definition.includes(
    'IF NOT public.membership_successor_elections_enabled(p_tenant_id) THEN')) {
    throw new Error('Refusing unexpected tenant reservation contract');
  }
  const state = (await db.query(`SELECT
    public.membership_successor_elections_enabled() AS global_enabled,
    public.membership_successor_elections_enabled('ff2df806-b321-4254-b651-3af11fccf1db'::uuid) AS bnms_enabled,
    (SELECT count(*)::integer FROM public.membership_successor_tenant_rollout WHERE enabled) enabled_tenants,
    (SELECT count(*)::integer FROM public.membership_successor_rollout WHERE enabled) enabled_global_rows,
    to_regprocedure($1) IS NOT NULL AS capability_installed,
    to_regprocedure($2) IS NOT NULL AS policy_installed`, [capability, policy])).rows[0];
  if (state.global_enabled !== false || state.bnms_enabled !== false
    || state.enabled_tenants !== 0 || state.enabled_global_rows !== 0) {
    throw new Error('Refusing enabled renewal rollout');
  }
  await assertServiceOnly(db, [reservation, 'public.membership_successor_elections_enabled(uuid)']);
  return { functions, metadata, state, contractHash: sha(JSON.stringify({ functions, metadata })) };
}

async function assertServiceOnly(db, signatures) {
  for (const signature of signatures) {
    const { rows: [grants] } = await db.query(`SELECT p.prosecdef AS definer,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
      EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public
      FROM pg_proc p WHERE p.oid=to_regprocedure($1)`, [signature]);
    if (!grants?.definer || !grants.service || grants.anon || grants.authenticated || grants.public) {
      throw new Error('Refusing unexpected service-only function grants');
    }
  }
}

async function snapshot(db) {
  const result = {};
  for (const table of tables) {
    // Fixed identifiers only; aggregate fingerprints do not expose member data.
    result[table] = (await db.query(`SELECT count(*)::integer AS count,
      md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)->>'id',
        to_jsonb(t)->>'tenant_id',md5(to_jsonb(t)::text)),'')) AS fingerprint
      FROM public.${table} t`)).rows[0];
  }
  return result;
}

export async function runExpiryOnlyMigration(args, connect = connectDestination) {
  let db;
  try {
    const { apply, verify, expected, expectedMigration } = validateExpiryOnlyArgs(args);
    const migration = await readFile(new URL(`../../supabase/migrations/${migrationName}.sql`, import.meta.url), 'utf8');
    const migrationHash = sha(migration);
    if (!apply && !verify) {
      console.log(JSON.stringify({ migration: migrationName, migrationHash, applied: false,
        next: '--expiry-only --verify-dest; approval then --apply with --expected-contract and --expected-migration' }));
      return;
    }
    if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL)) {
      throw new Error('Refusing connection: verified DEST target required');
    }
    if (apply && migrationHash !== expectedMigration) throw new Error('Refusing changed migration hash');
    db = await connect();
    await db.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    if (apply) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-successor-schema',0))");
      // Briefly freeze audited rows so concurrent activity cannot masquerade as migration drift.
      await db.query(`LOCK TABLE ${tables.map(table => `public.${table}`).join(',')} IN SHARE MODE`);
    }
    const before = await inspect(db);
    const records = await snapshot(db);
    if (!apply) {
      await db.query('ROLLBACK');
      console.log(JSON.stringify({ verifiedTarget: 'DEST', migrationHash, contractHash: before.contractHash,
        state: before.state, records, serviceOnlyReservation: true, applied: false }, null, 2));
      return;
    }
    if (before.contractHash !== expected) throw new Error('Refusing changed installed contract hash');
    if (before.state.capability_installed || before.state.policy_installed) {
      throw new Error('Refusing already or partially installed expiry-only migration');
    }
    await db.query(migration.replace(/^\s*BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''));
    const after = await inspect(db);
    await assertServiceOnly(db, [policy, capability, reservation]);
    if (!after.state.capability_installed || !after.state.policy_installed
      || !(await db.query('SELECT public.form_expiry_only_renewal_supported() supported')).rows[0].supported
      || !after.functions.find(row => row.proname === 'reserve_membership_successor')?.definition
        .includes('public.form_expiry_only_renewal_policy(prior,p_tenant_id,p_member_id)')) {
      throw new Error('Refusing missing new capability or reservation admission');
    }
    if (JSON.stringify(records) !== JSON.stringify(await snapshot(db))) {
      throw new Error('Refusing changed histories, assignments, elections or rollout records');
    }
    if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)
      || JSON.stringify(before.functions.filter(row => row.proname !== 'reserve_membership_successor'))
        !== JSON.stringify(after.functions.filter(row => ![
          'reserve_membership_successor', 'form_expiry_only_renewal_policy',
          'form_expiry_only_renewal_supported',
        ].includes(row.proname)))) {
      throw new Error('Refusing unrelated prerequisite contract changes');
    }
    await db.query("NOTIFY pgrst, 'reload schema'");
    await db.query('COMMIT');
    console.log(JSON.stringify({ target: 'DEST', applied: migrationName, migrationHash,
      beforeContract: before.contractHash, afterContract: after.contractHash, state: after.state,
      serviceOnlyGrants: true, recordsUnchanged: true, records }, null, 2));
  } catch (error) {
    await db?.query('ROLLBACK').catch(() => {});
    console.error(/^(Refusing|Applying)/.test(error.message) ? error.message
      : `Expiry-only verification/apply failed (${error.code || 'setup'}); no success asserted`);
    process.exitCode = 1;
  } finally {
    await db?.end();
  }
}