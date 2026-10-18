import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DESTINATION_PROJECT_REF, isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

export const MIGRATION = 'supabase/migrations/202610180002_sales_quote_naming.sql';
export const REVIEWED_SHA256 = 'bb404a63ae5964a9752d059cc799e065efa7a17384506be9c8919b2292501a7a';
const BASE_MIGRATION = 'supabase/migrations/202610120004_sales_automatic_quote_task_lists.sql';
const BASE_SHA256 = 'af11f507c063bf6d8abe713707220c9b63dbc770b3624add8607f91da62ab570';
export const PREDECESSOR = 'supabase/migrations/202610180001_sales_catalogue_visibility.sql';
const PREDECESSOR_SHA256 = 'c1891a3d63d0b0416089fd2840d641e2d57d883e407677d1482784ef4d152e93';
const root = new URL('../', import.meta.url);
const signature = 'public.patch_sales_settings(uuid,integer,jsonb,text,text)';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const normalizeBody = (text) => text.replace(/\s+/g, ' ').trim();

// Independently reconstruct exactly the reviewed SQL extensions for preflight.
// No database connection or application import is involved.
export function reviewedSettingsRpcBodies(baseSql, visibilitySql, namingSql) {
  const baseBody = baseSql.match(/AS \$\$([\s\S]*?)\$\$;/i)?.[1];
  if (!baseBody) throw new Error('Reviewed base settings RPC body is missing');
  function extend(definition, source) {
    for (const [anchor, tag] of [
      ['INSERT INTO public.sales_settings(tenant_id)', 'validation'],
      ['UPDATE public.sales_settings SET', 'update'],
    ]) {
      const payload = source.split(`$${tag}$`)[1];
      if (!payload || definition.split(anchor).length !== 2) {
        throw new Error('Reviewed settings extension anchors are not unique');
      }
      definition = definition.replace(anchor, () => payload);
    }
    return definition;
  }
  const predecessor = extend(baseBody, visibilitySql);
  return {
    predecessor: normalizeBody(predecessor),
    migrated: normalizeBody(extend(predecessor, namingSql)),
  };
}

export function validateApplyArguments(args, env) {
  if (args.length !== 3 || !args.includes('--apply')
      || !args.includes(`--reviewed-sha256=${REVIEWED_SHA256}`)
      || !args.includes(`--confirm-destination=${DESTINATION_PROJECT_REF}`)) {
    throw new Error('Explicit --apply, exact --reviewed-sha256, and --confirm-destination are required');
  }
  if (!isApprovedDestinationSupabaseTarget(env.DEST_DATABASE_URL, env.DEST_SUPABASE_URL)) {
    throw new Error('Only the pinned DEST_DATABASE_URL and DEST_SUPABASE_URL are allowed; SOURCE/runtime fallbacks are forbidden');
  }
  if (new URL(env.DEST_DATABASE_URL).search) {
    throw new Error('Database URL parameters are forbidden (including SSL overrides); TLS certificate verification is mandatory');
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const sql = await readFile(new URL(MIGRATION, root), 'utf8');
  if (digest(sql) !== REVIEWED_SHA256) throw new Error('Migration differs from the pinned review; stop and re-review');
  const base = await readFile(new URL(BASE_MIGRATION, root), 'utf8');
  const predecessor = await readFile(new URL(PREDECESSOR, root), 'utf8');
  if (digest(base) !== BASE_SHA256 || digest(predecessor) !== PREDECESSOR_SHA256) {
    throw new Error('Predecessor migration differs from the pinned review; stop and re-review');
  }
  const expectedBodies = reviewedSettingsRpcBodies(base, predecessor, sql);
  if (!args.length || (args.length === 1 && args[0] === '--review')) {
    // Offline by default: do not read credentials, import pg, or open a connection.
    console.log(JSON.stringify({
      migration: MIGRATION, sha256: REVIEWED_SHA256, destination: DESTINATION_PROJECT_REF,
      predecessor: PREDECESSOR, predecessorSha256: PREDECESSOR_SHA256,
      status: 'OFFLINE REVIEW ONLY — not applied; authorization and schema-before-code handoff pending',
    }, null, 2));
    return;
  }
  validateApplyArguments(args, env);
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: env.DEST_DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 15_000,
    application_name: 'task5150-reviewed-schema-handoff',
  });
  await client.connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    // Prevent a concurrent schema/RPC replacement between preflight and migration.
    await client.query('LOCK TABLE public.sales_settings IN ACCESS EXCLUSIVE MODE');
    const current = await client.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure', [signature]);
    const currentBody = current.rows[0]?.prosrc?.replace(/\s+/g, ' ').trim();
    if (![expectedBodies.predecessor, expectedBodies.migrated].includes(currentBody)) {
      throw new Error('Settings RPC is not the reviewed predecessor or this migration; stop and review newer schema');
    }
    const columns = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='sales_settings'
      AND column_name IN ('quote_task_list_name','show_internal_code','show_sku')`);
    if (columns.rowCount !== 3) throw new Error('Required task-list/catalogue visibility migrations are missing');
    // The reviewed file is independently transactional; keep its entire body in
    // this preflight transaction, removing only its explicit outer boundaries.
    await client.query(sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;\s*$/m, ''));
    const updated = await client.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure', [signature]);
    if (normalizeBody(updated.rows[0]?.prosrc || '') !== expectedBodies.migrated) {
      throw new Error('Settings RPC postcondition failed; visibility and naming must both survive');
    }
    const grants = await client.query(`SELECT
      has_function_privilege('service_role',$1,'EXECUTE') AS service,
      has_function_privilege('anon',$1,'EXECUTE') AS anon,
      has_function_privilege('authenticated',$1,'EXECUTE') AS authenticated`, [signature]);
    if (!grants.rows[0].service || grants.rows[0].anon || grants.rows[0].authenticated) {
      throw new Error('Settings RPC grant verification failed');
    }
    await client.query('COMMIT');
    console.log(`Applied ${MIGRATION}; grants verified; destination ${DESTINATION_PROJECT_REF}. Deploy code only after operator schema verification.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Never log connection strings, credentials, or database error payloads.
    console.error(`Sales naming migration stopped: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
