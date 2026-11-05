import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';
const migration = 'supabase/migrations/202701180001_cpd_history_event_title_fallback.sql';
const sql = readFileSync(migration, 'utf8');
const hash = createHash('sha256').update(sql).digest('hex');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ migration, sha256: hash, writes: false }));
} else {
  assert.ok(process.argv.includes(`--review-sha256=${hash}`), 'Reviewed migration hash required');
  const db = await connectDestination();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const signature = 'public.get_member_cpd_points_history(uuid,uuid,integer,integer)';
    const readCatalog = async () => (await db.query(`select prosrc,prosecdef,proconfig,
      pg_get_functiondef(oid) definition,
      has_function_privilege('service_role',oid,'EXECUTE') service,
      has_function_privilege('anon',oid,'EXECUTE') anon,
      has_function_privilege('authenticated',oid,'EXECUTE') authenticated,
      exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE') public
      from pg_proc where oid=$1::regprocedure`, [signature])).rows[0];
    const before = await readCatalog();
    const normalise = value => value.replace(/\s+/g, ' ').trim();
    const body = text => text.split('$$')[1];
    const original = readFileSync('supabase/migrations/20261118_member_cpd_points_history.sql', 'utf8');
    assert.ok([body(original), body(sql)].some(value => normalise(value) === normalise(before.prosrc)),
      'Live function differs from reviewed original and replacement; stop for review');
    await db.query("select set_config('request.jwt.claim.role','service_role',true)");
    const params = ['ff2df806-b321-4254-b651-3af11fccf1db', 'c1042adf-b8ee-40ae-aca5-48f9ddf4a5be'];
    const history = async () => (await db.query('select public.get_member_cpd_points_history($1,$2,1,100) data', params)).rows[0].data;
    const evidence = async () => (await db.query('select to_jsonb(l) data from member_cpd_points_ledger l where tenant_id=$1 and member_id=$2 order by id', params)).rows;
    const oldHistory = await history();
    const oldEvidence = await evidence();
    mkdirSync('generated-artifacts/cpd-title-repair', { recursive: true, mode: 0o700 });
    writeFileSync(`generated-artifacts/cpd-title-repair/before-${Date.now()}.json`,
      JSON.stringify({ migration, hash, before, oldHistory, oldEvidence }), { flag: 'wx', mode: 0o600 });
    await db.query(sql);
    const after = await readCatalog();
    assert.equal(after.prosecdef, true);
    assert.deepEqual(after.proconfig, ['search_path=public']);
    assert.equal(after.service, true);
    assert.equal(after.anon, false);
    assert.equal(after.authenticated, false);
    assert.equal(after.public, false);
    assert.deepEqual(await evidence(), oldEvidence);
    const newHistory = await history();
    const omitNames = h => ({ ...h, items: h.items.map(({ event_name, ...item }) => item) });
    assert.deepEqual(omitNames(newHistory), omitNames(oldHistory));
    const item = newHistory.items.find(i => i.id === '4325710d-6193-4be4-bb62-a52b6bd50ad0');
    assert.equal(item.event_name, 'BNMS MRT Webinar Series - Horizon Scanning - Clinical Trials and Radionuclide Production');
    await db.query('COMMIT');
    console.log(JSON.stringify({ applied: true, eventName: item.event_name, balance: newHistory.balance,
      ledgerUnchanged: true, serviceOnly: true, migration, sha256: hash }));
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { await db.end(); }
}
