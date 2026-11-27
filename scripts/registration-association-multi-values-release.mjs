// Offline-only payload builder. Live execution requires separately approved,
// project-pinned managed migration access; this module never connects to a DB.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PROJECT = 'lvmzliemqnieeoruhkik';
export const PATH = 'supabase/migrations/202612090014_registration_association_multi_values.sql';
export const REVIEW_SHA256 = 'e5653bea10799ba958a3aa871df49d39ee967b73ca1fdca47ca8da5214eed49d';
const OPTIONS = 'public.event_registration_association_options(uuid,uuid,boolean,text,text,uuid)';
const MATCHER = 'public.registration_association_values_match(text,jsonb)';
const preserved = [
  'public.registration_association_value_matches(text,text)',
  'public.guard_registration_association_config()',
  'public.assert_registration_account_association(uuid,jsonb)',
  'public.provision_public_ticket_members(uuid)',
  'public.insert_public_ticket_booking_batch(uuid,jsonb)',
];
const quote = value => `'${value.replaceAll("'", "''")}'`;
const md5 = value => createHash('md5').update(value).digest('hex');

export function expectedBodies(initial, extension) {
  const body = name => {
    const start = initial.indexOf(`CREATE FUNCTION public.${name}(`);
    assert.ok(start >= 0, `Missing source function ${name}`);
    const tail = initial.slice(start);
    return tail.slice(tail.indexOf('AS $$') + 5, tail.indexOf('END $$;') + 4);
  };
  const before = body('event_registration_association_options')
    .replace('WHERE v.tenant_id=$1', 'WHERE %s')
    .replace("r',tbl,val_tbl,owner_col)", "r',tbl,val_tbl,CASE WHEN k='group' THEN 'v.tenant_id=$1' ELSE 'true' END,owner_col)")
    .replace('LIMIT 51', '').replace('LIMIT 50', '')
    .replace('jsonb_array_length(result)>50', 'false')
    .replace('WHERE o.tenant_id=$1 AND ($2::uuid IS NULL OR o.id=$2)',
      "WHERE o.tenant_id=$1 AND position(''zombie'' in lower(coalesce(o.name,'''')))=0 AND ($2::uuid IS NULL OR o.id=$2)");
  const after = before
    .replace('public.registration_association_value_matches(v.value,$5)', 'public.registration_association_values_match(v.value,$5)')
    .replace("setting->>'value',k", "CASE WHEN setting ? 'values' THEN setting->'values'\n     WHEN jsonb_typeof(setting->'value')='array' THEN setting->'value'\n     ELSE jsonb_build_array(setting->'value') END,k");
  const match = extension.match(/SET search_path=pg_catalog AS \$\$([\s\S]*?END) \$\$;/);
  assert.ok(match, 'Missing reviewed matcher body');
  return { before, after, scalar: body('registration_association_value_matches'), helper: match[1] + ' ' };
}

export async function buildRelease(args = []) {
  const sql = await readFile(new URL(`../${PATH}`, import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(sql).digest('hex'), REVIEW_SHA256, 'Reviewed migration hash changed');
  const initial = await readFile(new URL('../supabase/migrations/202612090005_event_registration_associations.sql', import.meta.url), 'utf8');
  const bodies = expectedBodies(initial, sql);
  if (!args.length) return {
    project: PROJECT, path: PATH, sha256: REVIEW_SHA256, connectsToDatabase: false,
    modes: ['rehearse', 'install', 'verify'],
    requiredArguments: '--approved --review-sha256=<sha256> --mode=<mode>',
  };
  const mode = args.find(arg => arg.startsWith('--mode='))?.slice(7);
  assert.ok(['rehearse', 'install', 'verify'].includes(mode), 'Explicit mode required');
  assert.deepEqual([...args].sort(), ['--approved', `--review-sha256=${REVIEW_SHA256}`, `--mode=${mode}`].sort(),
    'Exact approval, reviewed hash and mode required');
  const snapshot = `SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
    'definition',md5(pg_get_functiondef(p.oid)),'acl',p.proacl::text) ORDER BY p.oid)
    FROM pg_proc p WHERE p.oid IN (${preserved.map(s => `${quote(s)}::regprocedure`).join(',')})`;
  const pre = `
DO $pre$
BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'Unexpected database'; END IF;
 IF to_regprocedure(${quote(MATCHER)}) IS NOT NULL THEN RAISE EXCEPTION 'Extension already exists; verify, never replay'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=${quote(OPTIONS)}::regprocedure
   AND md5(prosrc)=${quote(md5(bodies.before))} AND prosecdef
   AND proconfig=ARRAY['search_path=public, pg_temp']) THEN
   RAISE EXCEPTION 'Association prerequisites through 202612090011 differ'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.registration_association_value_matches(text,text)'::regprocedure
   AND md5(prosrc)=${quote(md5(bodies.scalar))} AND NOT prosecdef AND provolatile='i'
   AND proconfig=ARRAY['search_path=pg_catalog']) THEN RAISE EXCEPTION 'Scalar matcher differs'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
   AND table_name IN ('event','complex_event') AND column_name='registration_association_config'
   AND data_type='jsonb' AND column_default IS NULL)<>2 THEN RAISE EXCEPTION 'Settings schema differs'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgfoid='public.guard_registration_association_config()'::regprocedure
   AND tgrelid IN ('public.event'::regclass,'public.complex_event'::regclass) AND tgenabled='O')<>2
 THEN RAISE EXCEPTION 'Settings guards differ'; END IF;
 PERFORM set_config('registration_association_release.preserved',(${snapshot})::text,true);
END $pre$;`;
  const contract = `
DO $verify$
DECLARE signature text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=${quote(OPTIONS)}::regprocedure
   AND md5(prosrc)=${quote(md5(bodies.after))} AND prosecdef
   AND proconfig=ARRAY['search_path=public, pg_temp']) THEN RAISE EXCEPTION 'Installed lookup differs'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=${quote(MATCHER)}::regprocedure
   AND md5(prosrc)=${quote(md5(bodies.helper))} AND NOT prosecdef AND provolatile='i'
   AND proconfig=ARRAY['search_path=pg_catalog']) THEN RAISE EXCEPTION 'Installed helper differs'; END IF;
 FOREACH signature IN ARRAY ARRAY[${[OPTIONS, MATCHER, ...preserved].map(quote).join(',')}] LOOP
   IF has_function_privilege('anon',signature,'EXECUTE')
     OR has_function_privilege('authenticated',signature,'EXECUTE')
     OR NOT has_function_privilege('service_role',signature,'EXECUTE')
     OR EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.oid=signature::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE')
   THEN RAISE EXCEPTION 'Service-only grant check failed: %',signature; END IF;
 END LOOP;
END $verify$;`;
  const exercise = `
DO $exercise$
DECLARE role_name text; statement text; denied boolean; reached boolean:=false;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
   EXECUTE format('SET LOCAL ROLE %I',role_name);
   FOREACH statement IN ARRAY ARRAY[
     'SELECT public.registration_association_values_match(''a'',''["a"]''::jsonb)',
     'SELECT public.event_registration_association_options(NULL,NULL,NULL)'] LOOP
     denied:=false;
     BEGIN EXECUTE statement;
     EXCEPTION WHEN insufficient_privilege THEN denied:=true;
     END;
     IF NOT denied THEN RAISE EXCEPTION 'Expected role execution denial'; END IF;
   END LOOP;
   RESET ROLE;
 END LOOP;
 SET LOCAL ROLE service_role;
 IF public.registration_association_values_match('a','["b","a"]'::jsonb) IS DISTINCT FROM true
   OR public.registration_association_values_match('a','[]'::jsonb) IS DISTINCT FROM false
   OR public.registration_association_values_match('a','["a",null]'::jsonb) IS DISTINCT FROM false
   OR public.registration_association_values_match('["a","b"]','["b"]'::jsonb) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Synthetic matcher check failed'; END IF;
 BEGIN
   PERFORM public.event_registration_association_options(NULL,NULL,NULL);
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM='Invalid event' THEN reached:=true; ELSE RAISE; END IF;
 END;
 IF NOT reached THEN RAISE EXCEPTION 'Lookup service execution not reached'; END IF;
 RESET ROLE;
END $exercise$;`;
  const preservation = `
DO $preserved$
BEGIN
 IF (${snapshot}) IS DISTINCT FROM current_setting('registration_association_release.preserved')::jsonb
 THEN RAISE EXCEPTION 'Existing functions or grants changed'; END IF;
END $preserved$;`;
  if (mode === 'verify') return { project: PROJECT, mode, sha256: REVIEW_SHA256,
    query: `BEGIN READ ONLY; SET LOCAL statement_timeout='15s'; ${contract} ${exercise}
SELECT jsonb_build_object('exactDefinitions',true,'serviceOnlyGrants',true,'roleExecutionChecked',true,
'syntheticMatcherChecked',true,'eventDiscoverySearchPerformed',false) AS verification; COMMIT;` };
  const body = sql.replace(/^BEGIN;/, '').replace(/COMMIT;\s*$/, '');
  const operation = `${pre}\n${body}\n${contract}\n${exercise}\n${preservation}`;
  const query = mode === 'rehearse' ? `
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('registration-association-schema',0));
DO $rehearsal$
BEGIN
 ${operation}
 RAISE EXCEPTION 'Rollback successful rehearsal' USING ERRCODE='P5943';
EXCEPTION WHEN SQLSTATE 'P5943' THEN NULL;
END $rehearsal$;
${pre}
COMMIT;` : `
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('registration-association-schema',0));
${operation}
COMMIT;`;
  return { project: PROJECT, mode, sha256: REVIEW_SHA256, query };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await buildRelease(process.argv.slice(2)), null, 2));
}
