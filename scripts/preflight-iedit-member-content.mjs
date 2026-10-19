// Read-only pinned DEST preflight. Even --apply-dry-run performs NO DDL/DML.
// Actual deployment is intentionally not an option in this runner.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

export async function preflightIEdit(client) {
  const sql = await readFile(new URL('../supabase/migrations/202612310007_iedit_member_content.sql', import.meta.url), 'utf8');
  const guard = sql.slice(sql.indexOf('DO $guard$'), sql.indexOf('$guard$;', sql.indexOf('DO $guard$')) + '$guard$;'.length);
  // DO executes only SELECTs and RAISEs; READ ONLY also rejects unintended writes.
  await client.query(guard);
  const tables = [...sql.slice(sql.indexOf('FOREACH name IN ARRAY ARRAY['), sql.indexOf('] LOOP', sql.indexOf('FOREACH name IN ARRAY ARRAY[')))
    .matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  const columns = (await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])`,
  [[...tables,'i_edit_page','i_edit_page_element','member_content_source','member_content_reindex_job','member_content_chunk','member_ai_settings']])).rows;
  const has = (table, column) => columns.some(r => r.table_name===table && r.column_name===column);
  const missing = [];
  for (const [table, required] of Object.entries({
    i_edit_page: ['id','tenant_id','builder_type','microsite_id','status'],
    i_edit_page_element: ['id','page_id'],
    member_content_source: ['tenant_id','content_type','source_id','generation','active_generation','claim_token','claim_started_at'],
    member_content_reindex_job: ['tenant_id','content_type','source_id'],
    member_content_chunk: ['source_generation','provenance','access_scope','embedding_model'],
    member_ai_settings: ['allowed_content_types'],
  })) for (const column of required) if (!has(table,column)) missing.push(`${table}.${column}`);
  const absent = [];
  for (const table of tables) {
    if (!columns.some(r => r.table_name===table)) { absent.push(table); continue; }
    if (table==='organization_preference_value' || table==='member_resource_category') {
      const parent = table==='organization_preference_value' ? 'organization' : 'member';
      const foreignKey = `${parent}_id`;
      if (!has(table,foreignKey) || !has(parent,'tenant_id')) missing.push(`${table} parent resolver`);
    } else if (!has(table,table==='tenant'?'id':'tenant_id')) missing.push(`${table}.tenant_id`);
  }
  if (missing.length) throw new Error(`iEdit schema preflight failed: ${missing.join(', ')}`);
  const authority = (await client.query(`SELECT p.proname,p.prosecdef,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') service
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1::text[])`,
  [['publish_member_content_knowledge','claim_member_content_generation','invalidate_member_content_source','match_member_content_chunks']])).rows;
  if (authority.length!==4 || authority.some(r => r.anon || r.authenticated || !r.service) ||
      !authority.find(r => r.proname==='publish_member_content_knowledge')?.prosecdef) {
    throw new Error('iEdit service-only function authority preflight failed');
  }
  return { project: PROJECT, mode: 'read-only', exactFunctionGuards: 'passed', schema: 'passed', authority: 'passed',
    absentOptionalTables: absent, applied: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some(arg => !['--preflight','--apply-dry-run'].includes(arg))) {
    throw new Error('Only --preflight or --apply-dry-run are supported; this runner cannot apply changes');
  }
  const client = await connectDestination();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='15s'");
    console.log(JSON.stringify(await preflightIEdit(client), null, 2));
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}
