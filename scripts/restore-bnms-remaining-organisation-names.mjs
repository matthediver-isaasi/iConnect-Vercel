// Owner-authorised exact-ID name recovery. No fuzzy matches or organisation merges.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { connectDestination } from './lib/member-index-destination.mjs';

const apply = process.argv.includes('--apply');
assert(process.argv.slice(2).every(arg => arg === '--apply'));
const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const dir = 'generated-artifacts/bnms-organisation-name-recovery';
const sources = [
  ['attached_assets/Organisation_data_updated_to_import_31.08.26_1788194727640.csv', 'id', 'name'],
  ['attached_assets/bnms_organisation_addresses_enriched_(1)_1792051420856.csv', 'Organisation ID', 'Organisation Name'],
];
const candidates = new Map();
const hashes = {};
for (const [file, idKey, nameKey] of sources) {
  const bytes = await readFile(file);
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
  for (const row of parse(bytes, { columns: true, bom: true, skip_empty_lines: true })) {
    const id = row[idKey]?.trim(), name = row[nameKey]?.trim();
    if (!id || !name) continue;
    const choices = candidates.get(id) || [];
    choices.push({ name, source: file });
    candidates.set(id, choices);
  }
}
await mkdir(dir, { recursive: true, mode: 0o700 });
const c = await connectDestination();
try {
  await c.query('begin');
  await c.query("set local lock_timeout='5s'");
  const before = (await c.query('select to_jsonb(o) row from organization o where tenant_id=$1 order by id', [tenant])).rows.map(r=>r.row);
  let manifest;
  try { manifest = JSON.parse(await readFile(`${dir}/manifest.json`, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const blanks = before.filter(r=>!r.name?.trim());
    assert.equal(blanks.length, 42, 'Unexpected starting cohort');
    const plan = [], unresolved = [];
    for (const row of blanks) {
      const evidence = candidates.get(row.id) || [];
      const names = [...new Set(evidence.map(e=>e.name))];
      if (names.length === 1) plan.push({ id:row.id, name:names[0], evidence });
      else unresolved.push(row.id);
    }
    assert.equal(plan.length, 41);
    assert.deepEqual(unresolved, ['090fc9e9-b450-41e0-9f64-afc1d73dbf43']);
    manifest = { tenant, hashes, plan, unresolved };
    await writeFile(`${dir}/manifest.json`, JSON.stringify(manifest,null,2), { mode:0o600, flag:'wx' });
  }
  assert.equal(manifest.tenant, tenant);
  assert.deepEqual(manifest.hashes, hashes);
  const ids = manifest.plan.map(r=>r.id);
  const locked = (await c.query('select to_jsonb(o) row from organization o where tenant_id=$1 and id=any($2::uuid[]) order by id for update', [tenant,ids])).rows.map(r=>r.row);
  assert.equal(locked.length, 41);
  const receipt = { apply, committed:false, at:new Date().toISOString(), before:locked, changed:[], alreadyCorrect:0, unresolved:manifest.unresolved };
  const out = `${dir}/${apply?'apply':'check'}-${Date.now()}.json`;
  await writeFile(out, JSON.stringify(receipt,null,2),{mode:0o600});
  for (const item of manifest.plan) {
    const old = locked.find(r=>r.id===item.id);
    if (old.name === item.name) { receipt.alreadyCorrect++; continue; }
    assert.equal(old.name?.trim() || '', '', 'Never overwrite a populated name');
    const result = await c.query(`update organization set name=$3 where tenant_id=$1 and id=$2 and coalesce(btrim(name),'')='' returning to_jsonb(organization) row`, [tenant,item.id,item.name]);
    assert.equal(result.rowCount,1);
    const after = result.rows[0].row;
    const {name:oldName,updated_at:oldTime,...oldOther}=old;
    const {name:newName,updated_at:newTime,...newOther}=after;
    assert.deepEqual(newOther,oldOther,'Unrelated organisation fields changed');
    assert.equal(newName,item.name);
    receipt.changed.push({id:item.id,name:newName,evidence:item.evidence,after});
  }
  receipt.blankRemaining = Number((await c.query("select count(*) from organization where tenant_id=$1 and coalesce(btrim(name),'')=''",[tenant])).rows[0].count);
  assert.equal(receipt.blankRemaining,1);
  await writeFile(out, JSON.stringify(receipt,null,2),{mode:0o600});
  await c.query(apply?'commit':'rollback');
  receipt.committed=apply;
  await writeFile(out, JSON.stringify(receipt,null,2),{mode:0o600});
  console.log(JSON.stringify({applied:apply,restored:receipt.changed.length,alreadyCorrect:receipt.alreadyCorrect,blankRemaining:receipt.blankRemaining,unrelatedFieldsUnchanged:true}));
} catch(error) { await c.query('rollback'); throw error; }
finally { await c.end(); }
