import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID, INPUT, checksum, readWorkbook, readAll, buildReport } from './bnms-posters-proposal.mjs';
import { destinationConfig, durableFile, writeComplete, syncDirectory } from './bnms-youtube-categorisation-io.mjs';

const PACKAGE = 'reports/bnms-posters/2026-09-15T13-50-57.289Z';
const SHA = 'b04851017a0f848daec828f976de05e2904d5c3ba19d6aa81038486a97be9c16';
const allowed = ['title','is_public','subcategories'];
export function patchFor(row) {
  assert.equal(row.status,'update');
  assert.notEqual(row.row,567);
  assert.equal(row.before.tenant_id,TENANT_ID);
  assert.equal(row.issues.length,0);
  const patch = {};
  for (const [key,change] of Object.entries(row.changes)) {
    assert(allowed.includes(key),`Unapproved field: ${key}`);
    assert.deepEqual(change.before,row.before[key]);
    assert.deepEqual(change.proposed,row.proposed[key]);
    patch[key] = change.proposed;
  }
  assert.equal(patch.is_public,false);
  assert(row.before.subcategories.every(v=>patch.subcategories.includes(v)));
  return patch;
}
// Compare timestamps semantically across REST and SQL JSON encodings.
export function assertBefore(actual, expected) {
  assert(actual,'Missing resource');
  for (const [key,value] of Object.entries(expected)) {
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) && typeof actual[key] === 'string') assert.equal(Date.parse(actual[key]),Date.parse(value));
    else assert.deepEqual(actual[key],value,`Before-value drift: ${expected.id} ${key}`);
  }
}
export function planCurrent(rows, approved) {
  const byId = new Map(rows.map(r=>[r.id,r]));
  return approved.map(row=>{
    const patch = patchFor(row), current = byId.get(row.before.id);
    try { assertBefore(current,{...row.before,...patch}); return {row,patch,done:true}; }
    catch { assertBefore(current,row.before); return {row,patch,done:false}; }
  });
}
async function main() {
  assert(process.argv.length === 3 && ['--dry-run','--apply'].includes(process.argv[2]),'Specify --dry-run or --apply');
  const apply = process.argv[2] === '--apply';
  const bytes = readFileSync(`${PACKAGE}/audit.json`);
  assert.equal(checksum(bytes),SHA,'Approval package changed');
  const report = JSON.parse(bytes), approved = report.rows.filter(r=>r.status==='update');
  assert.equal(approved.length,920);
  assert.deepEqual(report.rows.filter(r=>r.status==='blocked').map(r=>r.row),[567]);
  const workbook = readWorkbook(readFileSync(INPUT));
  assert.equal(workbook.checksum,report.inputChecksum);
  const config = destinationConfig(process.env.DEST_SUPABASE_URL,process.env.DEST_DATABASE_URL);
  assert(process.env.DEST_SUPABASE_KEY,'DEST REST key required');
  const rest = createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(input,init)=>{assert.equal((init?.method||'GET').toUpperCase(),'GET');return fetch(input,init);}},
  });
  const snapshot = async()=>({
    resources:(await readAll(rest,'resource','*')).rows,
    categories:(await readAll(rest,'resource_category','id,tenant_id,name,subcategories,excluded_role_ids,subcategory_excluded_role_ids')).rows,
  });
  const initial = await snapshot();
  const originalSnapshot = JSON.parse(readFileSync(`${PACKAGE}/snapshot.json`));
  assert.equal(checksum(readFileSync(`${PACKAGE}/snapshot.json`)),'48215417fe3201375f0ed37dcef77b8341fd296822c381067b941b76046a7ba0');
  assert.deepEqual(initial.categories,originalSnapshot.categories,'Taxonomy drift');
  const fresh = buildReport(workbook,initial.resources,initial.categories);
  for (const row of approved) {
    const current = fresh.rows.find(r=>r.row===row.row);
    assert.deepEqual(current.candidateIds,row.candidateIds,'Identity drift');
    assert.equal(current.issues.length,0);
    assertBefore(current.proposed,row.proposed);
  }
  assertBefore(initial.resources.find(r=>r.id===report.rows.find(r=>r.row===567).before.id),report.rows.find(r=>r.row===567).before);
  const plan = planCurrent(initial.resources,approved);
  if (!apply) return console.log(JSON.stringify({mode:'dry-run',updates:plan.filter(p=>!p.done).length,excluded:[567],writes:0}));
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert(response.ok);
  const ca = await response.text();
  assert.equal(checksum(ca),'700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7');
  const client = new pg.Client({...config,ssl:{rejectUnauthorized:true,ca}});
  const dir = `reports/bnms-posters/execution/${new Date().toISOString().replaceAll(':','-')}`;
  mkdirSync(dir,{recursive:true});
  for (const path of [dir,`${dir}/..`,'reports/bnms-posters','reports','.']) syncDirectory(path);
  const save = (name,value)=>durableFile(`${dir}/${name}.json`,JSON.stringify(value,null,2));
  save('approval',{package:PACKAGE,sha256:SHA,approval:'Approve all listed changes; leave row 567 excluded',patches:plan.map(p=>({row:p.row.row,id:p.row.before.id,patch:p.patch}))});
  save('before',initial);
  const fd = openSync(`${dir}/journal.jsonl`,'ax',0o600);
  syncDirectory(dir);
  const journal = entry=>writeComplete(fd,JSON.stringify({at:new Date().toISOString(),...entry})+'\n');
  const sqlSnapshot = async()=> {
    const resources = (await client.query('SELECT to_jsonb(r) AS record FROM public.resource r WHERE tenant_id=$1 ORDER BY id',[TENANT_ID])).rows.map(r=>r.record);
    return resources;
  };
  async function execute(baseline) {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='10s'");
      await client.query("SET LOCAL statement_timeout='60s'");
      // Serialize writes while checking full before-values, including unchanged fields.
      await client.query('LOCK TABLE public.resource, public.resource_category IN SHARE ROW EXCLUSIVE MODE');
      const triggers = await client.query("SELECT tgname FROM pg_trigger WHERE tgrelid='public.resource'::regclass AND NOT tgisinternal");
      const rules = await client.query("SELECT rulename FROM pg_rules WHERE schemaname='public' AND tablename='resource'");
      assert.equal(triggers.rowCount,0,'Unreviewed resource triggers');
      assert.equal(rules.rowCount,0,'Unreviewed resource rules');
      const tenant = await client.query('SELECT name FROM public.tenant WHERE id=$1',[TENANT_ID]);
      assert.equal(tenant.rows[0]?.name,'BNMS');
      const categories = await client.query('SELECT id,tenant_id,name,subcategories,excluded_role_ids,subcategory_excluded_role_ids FROM public.resource_category WHERE tenant_id=$1 ORDER BY id',[TENANT_ID]);
      assert.deepEqual(categories.rows,initial.categories);
      const before = await sqlSnapshot();
      assert.equal(before.length,baseline.length,'Resource count drift');
      const baselineById = new Map(baseline.map(r=>[r.id,r]));
      for (const row of before) {
        assert(baselineById.has(row.id),'Resource identity drift');
        assertBefore(row,baselineById.get(row.id));
      }
      const currentPlan = planCurrent(before,approved);
      const expected = new Map(before.map(r=>[r.id,r]));
      let writes = 0;
      for (const {row,patch,done} of currentPlan) {
        if (done) continue;
        const current = expected.get(row.before.id);
        journal({phase:'intent',row:row.row,id:current.id,before:current,patch});
        const keys = Object.keys(patch);
        // jsonb_populate_record uses the actual column types (arrays or JSONB).
        const result = await client.query(`UPDATE public.resource r SET ${keys.map(k=>`"${k}"=p."${k}"`).join(',')} FROM jsonb_populate_record(NULL::public.resource,$1::jsonb) p WHERE r.id=$2 AND r.tenant_id=$3 RETURNING to_jsonb(r) AS record`,[JSON.stringify(patch),current.id,TENANT_ID]);
        assert.equal(result.rowCount,1);
        const after = result.rows[0].record;
        const intended = {...current,...patch};
        assert.deepEqual(after,intended,'Unapproved field changed');
        expected.set(current.id,after);
        journal({phase:'updated',row:row.row,id:current.id,after});
        writes++;
      }
      const after = await sqlSnapshot();
      assert.deepEqual(after,[...expected.values()],'Unexpected resource changes');
      assert(planCurrent(after,approved).every(p=>p.done));
      const finalCategories = await client.query('SELECT id,tenant_id,name,subcategories,excluded_role_ids,subcategory_excluded_role_ids FROM public.resource_category WHERE tenant_id=$1 ORDER BY id',[TENANT_ID]);
      assert.deepEqual(finalCategories.rows,initial.categories,'Taxonomy changed in transaction');
      journal({phase:'commit-intent',writes});
      await client.query('COMMIT');
      journal({phase:'committed',writes});
      return {writes,after};
    } catch (error) {
      await client.query('ROLLBACK');
      journal({phase:'failed-or-commit-uncertain'});
      throw error;
    }
  }
  try {
    await client.connect();
    const result = await execute(initial.resources);
    const replay = await execute(result.after);
    assert.equal(replay.writes,0);
    const final = await snapshot();
    assert.deepEqual(final.categories,initial.categories);
    assert(planCurrent(final.resources,approved).every(p=>p.done));
    // Full-row REST verification includes excluded and unrelated records.
    const expected = new Map(result.after.map(r=>[r.id,r]));
    assert.equal(final.resources.length,expected.size);
    for (const row of final.resources) assertBefore(row,expected.get(row.id));
    save('after',final);
    const verification = {updates:result.writes,inserts:0,excluded:[567],replayWrites:replay.writes,memberOnlyVerified:920,titleChangesApproved:191,taxonomyUnchanged:true,allOtherFieldsPreserved:true,resources:final.resources.length};
    save('verification',verification);
    console.log(JSON.stringify({directory:dir,...verification}));
  } finally {closeSync(fd);await client.end();}
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});