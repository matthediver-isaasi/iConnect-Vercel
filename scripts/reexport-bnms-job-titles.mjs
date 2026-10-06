// Read-only replacement export when the isolated task's private evidence
// did not transfer. Never claim to reconstruct its unavailable review cohort.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connectDestination } from './annual-meeting-destination.mjs';
import { TENANT, hash, workbookBytes, parseCorrections } from './bnms-job-title-repair-core.mjs';
import { liveSchema, readMembers } from './bnms-job-title-repair-db.mjs';

const directory = 'private/bnms-job-title-audit/replacement';
process.on('uncaughtException', () => {
  console.error('Replacement export stopped. Inspect private evidence without logging member records.');
  process.exitCode = 1;
});
execFileSync('git', ['check-ignore', '-q', `${directory}/manual-manifest.json`]);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const save = (name, bytes) => fs.writeFileSync(`${directory}/${name}`, bytes, { mode: 0o600, flag: 'wx' });
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal((await db.query('SELECT name FROM tenant WHERE id=$1', [TENANT])).rows[0]?.name, 'BNMS');
  const members = await readMembers(db);
  assert.ok(members.length > 0);
  assert.ok(members.every(m => m.tenant_id === TENANT));
  assert.equal(new Set(members.map(m => m.id)).size, members.length);
  const blank = m => !m.job_title?.trim();
  const rows = members.sort((a,b) => Number(blank(b)) - Number(blank(a))
    || String(a.last_name || '').localeCompare(String(b.last_name || ''))
    || a.id.localeCompare(b.id)).map(member => ({
    member,
    reason: blank(member)
      ? 'Missing job title — please complete.'
      : 'Existing title — optional review; leave correction blank to preserve. Original review classification unavailable.',
  }));
  const summary = {
    'Export basis': 'Fresh read-only production export, not a reconstruction of the previous review decisions.',
    'BNMS members (all statuses)': members.length,
    'Missing titles — shown first': members.filter(blank).length,
    'Existing titles — optional review': members.filter(m => !blank(m)).length,
    'Database changes made': 'None',
    'Migrations needed or applied': 'None',
  };
  const manifest = {
    mode: 'returned', tenant: TENANT, exportedAt: new Date().toISOString(),
    schemaHash: hash(await liveSchema(db)), rows,
  };
  const bytes = workbookBytes(rows, summary);
  assert.equal(parseCorrections(bytes, rows).length, 0);
  save('manual-manifest.json', JSON.stringify(manifest, null, 2));
  save('BNMS-job-titles-replacement.xlsx', bytes);
  save('summary.json', JSON.stringify({ ...summary, manifestHash: hash(manifest) }, null, 2));
  await db.query('ROLLBACK');
  console.log(JSON.stringify({ rows: rows.length, blank: members.filter(blank).length, bytes: bytes.length, blankWorkbookWrites: 0 }));
} finally {
  await db.query('ROLLBACK').catch(() => {});
  await db.end();
}
