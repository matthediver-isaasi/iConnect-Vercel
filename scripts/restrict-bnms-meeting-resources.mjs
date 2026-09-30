/**
 * One-off, destination-pinned visibility correction. Default: read-only.
 * node scripts/restrict-bnms-meeting-resources.mjs [--apply]
 * No workbook, title, URL, Events fallback, or resource_type matching.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationConfig, durableFile, syncDirectory } from './bnms-youtube-categorisation-io.mjs';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const PROJECT = 'lvmzliemqnieeoruhkik';
const COLLECTION = 'Spring Meeting 2026';
const TYPES = ['Posters', 'Presentation'];
export const predicate = `tenant_id = $1 AND subcategories @> ARRAY[$2]::text[]
  AND subcategories && $3::text[]`;
const params = [TENANT, COLLECTION, TYPES];
export function matches(row) {
  return row.tenant_id === TENANT && Array.isArray(row.subcategories)
    && row.subcategories.includes(COLLECTION)
    && TYPES.some(type => row.subcategories.includes(type));
}
export function checkTaxonomy(categories) {
  for (const [name, values] of [['Collection', [COLLECTION]], ['Resource Type', TYPES]]) {
    const definitions = categories.filter(row => row.name === name);
    assert.equal(definitions.length, 1, `Ambiguous taxonomy: ${name}`);
    for (const value of values) {
      assert(definitions[0].subcategories?.includes(value), `Missing classification: ${value}`);
      assert.equal(categories.filter(row => row.subcategories?.includes(value)).length, 1,
        `Classification has multiple meanings: ${value}`);
    }
  }
}
async function snapshot(client) {
  return (await client.query(
    'SELECT to_jsonb(r) AS record FROM public.resource r WHERE tenant_id = $1 ORDER BY id',
    [TENANT],
  )).rows.map(row => row.record);
}
async function foreignFingerprint(client) {
  return (await client.query(`SELECT count(*)::int AS count,
    md5(coalesce(string_agg(to_jsonb(r)::text, '' ORDER BY id), '')) AS hash
    FROM public.resource r WHERE tenant_id IS DISTINCT FROM $1`, [TENANT])).rows[0];
}
export function verify(before, after) {
  assert.deepEqual(after, before.map(row => matches(row) ? { ...row, is_public: false } : row),
    'Unexpected field, visibility, or resource-set change');
  assert.equal(after.filter(row => matches(row) && row.is_public !== false).length, 0);
}
async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 1 && ['--apply', '--dry-run'].includes(args[0])),
    'Only --dry-run or --apply supported');
  const apply = args[0] === '--apply';
  const config = destinationConfig(process.env.DEST_SUPABASE_URL, process.env.DEST_DATABASE_URL);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert(response.ok, 'Cannot load Supabase CA');
  const ca = await response.text();
  assert.equal(createHash('sha256').update(ca).digest('hex'),
    '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7');
  const client = new pg.Client({ ...config, ssl: { rejectUnauthorized: true, ca } });
  let save;
  let committed = false;
  try {
    await client.connect();
    await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    if (apply) await client.query('LOCK TABLE public.resource, public.resource_category IN SHARE ROW EXCLUSIVE MODE');
    const tenant = (await client.query('SELECT id, name FROM public.tenant WHERE id=$1', [TENANT])).rows;
    assert.deepEqual(tenant, [{ id: TENANT, name: 'BNMS' }]);
    const categories = (await client.query(
      'SELECT id, name, subcategories FROM public.resource_category WHERE tenant_id=$1 ORDER BY id', [TENANT],
    )).rows;
    checkTaxonomy(categories);
    const triggers = (await client.query(
      "SELECT tgname, pg_get_triggerdef(oid) AS definition, pg_get_functiondef(tgfoid) AS function FROM pg_trigger WHERE tgrelid='public.resource'::regclass AND NOT tgisinternal",
    )).rows;
    const dependencies = (await client.query("SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='invalidate_member_content_source' ORDER BY oid")).rows;
    const triggerHash = createHash('sha256').update(JSON.stringify({ triggers, dependencies })).digest('hex');
    // Reviewed trigger only invalidates this resource's member-search generation
    // and queues reindexing. It does not modify resource settings.
    if (apply) assert.equal(triggerHash, '8400db8e7775b2f6e0f0696ba8919689d0b8dae90e51872f2594c0d07949fc29', 'Resource trigger definitions changed');
    else console.log(JSON.stringify({ triggerHash }));
    const before = await snapshot(client);
    const selected = before.filter(matches);
    const changes = selected.filter(row => row.is_public !== false);
    const sqlIds = (await client.query(`SELECT id FROM public.resource WHERE ${predicate} ORDER BY id`, params)).rows.map(row => row.id);
    assert.deepEqual(sqlIds, selected.map(row => row.id), 'SQL and audit selection disagree');
    const summary = {
      destination: PROJECT, tenant: TENANT, matched: selected.length,
      alreadyMemberOnly: selected.length - changes.length, changesNeeded: changes.length,
      classifications: TYPES.map(type => ({ type, count: selected.filter(row => row.subcategories.includes(type)).length })),
    };
    if (!apply) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ ...summary, mode: 'read-only', sample: selected.slice(0, 3).map(({ id, subcategories, is_public }) => ({ id, subcategories, is_public })) }, null, 2));
      return;
    }
    const directory = `reports/bnms-meeting-resource-restriction/${new Date().toISOString().replaceAll(':', '-')}`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const path of [directory, `${directory}/..`, 'reports', '.']) syncDirectory(path);
    save = (name, value) => durableFile(`${directory}/${name}.json`, JSON.stringify(value, null, 2));
    const foreignBefore = await foreignFingerprint(client);
    save('before', { ...summary, capturedAt: new Date().toISOString(), matched: selected,
      tenantResources: before, taxonomy: categories, otherTenants: foreignBefore });
    save('intent', { ids: changes.map(row => row.id), patch: { is_public: false } });
    const result = await client.query(`UPDATE public.resource SET is_public=false
      WHERE ${predicate} AND id = ANY($4::uuid[]) AND is_public IS DISTINCT FROM false RETURNING id`,
    [...params, changes.map(row => row.id)]);
    assert.deepEqual(result.rows.map(row => row.id).sort(), changes.map(row => row.id).sort());
    verify(before, await snapshot(client));
    assert.deepEqual(await foreignFingerprint(client), foreignBefore, 'Other tenants changed');
    save('verified-before-commit', { changed: result.rowCount, failed: 0 });
    await client.query('COMMIT');
    committed = true;
    // Fresh database snapshot, not the transaction's cached before/after state.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const fresh = await snapshot(client);
    verify(before, fresh);
    const remaining = (await client.query(`SELECT count(*)::int AS count FROM public.resource
      WHERE ${predicate} AND is_public IS DISTINCT FROM false`, params)).rows[0].count;
    assert.equal(remaining, 0, 'Replay still needs changes');
    await client.query('COMMIT');
    const report = { ...summary, changed: result.rowCount, failed: 0,
      remainingPublicOrUnset: remaining, repeatRunChangesNeeded: remaining,
      unrelatedFieldsPreserved: true, otherTenantsUnchangedInTransaction: true,
      verifiedAt: new Date().toISOString(), schemaMigrationNeeded: false, auditDirectory: directory };
    save('after', fresh.filter(matches));
    save('report', report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (save) save('failure', { committed, message: error.message });
    console.error(JSON.stringify({ status: committed ? 'committed-verification-failed' : 'not-confirmed-committed', error: error.message }));
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();