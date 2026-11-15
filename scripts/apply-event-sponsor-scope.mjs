// Explicitly authorised external DEST migration. Default is a rolled-back rehearsal.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const apply = process.argv.includes('--apply');
const migration = await readFile(new URL('../supabase/migrations/202701240001_event_owned_sponsor_categories.sql', import.meta.url), 'utf8');
const db = await connectDestination();
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
  await db.query('LOCK TABLE public.event_sponsor, public.event_sponsor_category, public.event_sponsor_assignment IN SHARE ROW EXCLUSIVE MODE');
  const installed = await db.query("SELECT 1 FROM pg_constraint WHERE conname='sponsor_assignment_category_scope' AND conrelid='public.event_sponsor_assignment'::regclass");
  if (installed.rowCount) throw new Error('Sponsor scope migration is already installed; refusing to replay.');
  const before = (await db.query(`SELECT a.id,to_jsonb(a)-'category_id' retained,
    coalesce(a.category_id,s.category_id) expected_category, c.name category_name
    FROM public.event_sponsor_assignment a
    JOIN public.event_sponsor s ON s.id=a.sponsor_id
    LEFT JOIN public.event_sponsor_category c ON c.id=coalesce(a.category_id,s.category_id)
    ORDER BY a.id`)).rows;
  const sponsors = (await db.query('SELECT to_jsonb(s) data FROM public.event_sponsor s ORDER BY id')).rows;
  const categories = (await db.query('SELECT to_jsonb(c) data FROM public.event_sponsor_category c ORDER BY id')).rows;
  await db.query(migration.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
  const after = (await db.query(`SELECT a.id,to_jsonb(a)-'category_id' retained,c.legacy_category_id expected_category,c.name category_name
    FROM public.event_sponsor_assignment a LEFT JOIN public.event_sponsor_category c ON c.id=a.category_id ORDER BY a.id`)).rows;
  assert.deepEqual(after,before,'Assignment details or effective category names changed');
  assert.deepEqual((await db.query("SELECT to_jsonb(s)-'organization_id' data FROM public.event_sponsor s ORDER BY id")).rows,sponsors);
  assert.deepEqual((await db.query("SELECT to_jsonb(c)-'event_id'-'event_type'-'legacy_category_id' data FROM public.event_sponsor_category c WHERE event_id IS NULL ORDER BY id")).rows,categories);
  const invalid = (await db.query(`SELECT count(*)::int n FROM public.event_sponsor_assignment a
    JOIN public.event_sponsor_category c ON c.id=a.category_id
    WHERE (c.tenant_id,c.event_id,c.event_type) IS DISTINCT FROM (a.tenant_id,a.event_id,a.event_type)`)).rows[0].n;
  assert.equal(invalid,0);
  // Rejected writes are checked on real schema, always rolled back to savepoint.
  const first = after[0];
  if (first) {
    await db.query('SAVEPOINT protection_check');
    let rejected=false;
    try {
      await db.query("UPDATE public.event_sponsor_assignment SET event_id='00000000-0000-0000-0000-000000000000' WHERE id=$1",[first.id]);
    } catch (err) { assert.equal(err.code,'23514'); rejected=true; }
    await db.query('ROLLBACK TO SAVEPOINT protection_check');
    assert.ok(rejected,'Scope guard must reject reparenting');
  }
  assert.equal((await db.query(`SELECT has_function_privilege('anon','public.guard_event_sponsor_scope()','EXECUTE') OR
    has_function_privilege('authenticated','public.delete_event_sponsor_scope()','EXECUTE') exposed`)).rows[0].exposed,false);
  const scopedCategories = (await db.query('SELECT count(*)::int n FROM public.event_sponsor_category WHERE event_id IS NOT NULL')).rows[0].n;
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({project:PROJECT, applied:apply, rehearsalRolledBack:!apply,
    assignmentsPreserved:after.length, sponsorsPreserved:sponsors.length, legacyCategoriesPreserved:categories.length, eventCategories:scopedCategories, protectionsVerified:true}));
} catch(err) {
  await db.query('ROLLBACK');
  throw err;
} finally { await db.end(); }
