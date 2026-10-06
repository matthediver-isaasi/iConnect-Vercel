import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './annual-meeting-destination.mjs';
import { DIRECTORY, savePrivate } from './audit-bnms-job-titles.mjs';
import { hash, buildAudit, repairItem, workbookBytes, parseCorrections } from './bnms-job-title-repair-core.mjs';
import { executeRepair, readMembers } from './bnms-job-title-repair-db.mjs';

export async function main(args = process.argv.slice(2)) {
  const [mode, manifestPath, expectedHash, ...flags] = args;
  assert.ok(['cleanup', 'returned'].includes(mode), 'Usage: cleanup|returned MANIFEST_JSON SHA256 [--apply] [--file RETURNED_XLSX]');
  const bytes = fs.readFileSync(manifestPath), manifest = JSON.parse(bytes);
  assert.equal(hash(manifest), expectedHash, 'Manifest hash differs from reviewed authority');
  let apply = false, returned;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--apply' && !apply) apply = true;
    else if (flags[i] === '--file' && flags[i + 1] && !returned) returned = flags[++i];
    else throw Error('Unknown or duplicate option');
  }
  assert.equal(manifest.mode, mode);
  const items = mode === 'cleanup' ? buildAudit(manifest.snapshot, manifest.evidence, manifest.review).filter(r => r.classification === 'confirmed-misplaced').map(repairItem)
    : parseCorrections(fs.readFileSync(returned), manifest.rows);
  const runHash = hash({ mode, items, schemaHash: manifest.schemaHash });
  const receiptPath = `${DIRECTORY}/${runHash}-receipt.json`;
  const db = await connectDestination();
  try {
    if (mode === 'returned' && fs.existsSync(receiptPath)) {
      const receipt = JSON.parse(fs.readFileSync(receiptPath));
      assert.equal(receipt.runHash, runHash);
      const members = await readMembers(db);
      for (const member of receipt.after) assert.deepEqual(members.find(m => m.id === member.id), member, 'Stale previously applied member');
      console.log(JSON.stringify({ changed: 0, replayed: receipt.after.length, committedReceiptVerified: true }));
      return;
    }
    const result = await executeRepair(db, items, manifest.schemaHash, {
      apply, journal: (stage, data) => savePrivate(`${runHash}-${stage}-${Date.now()}.json`, data),
    });
    if (apply && !fs.existsSync(receiptPath)) savePrivate(`${runHash}-receipt.json`, { runHash, committedAt: new Date().toISOString(), ...result });
    console.log(JSON.stringify({ mode, apply, ...Object.fromEntries(Object.entries(result).filter(([k]) => k !== 'after')) }));
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error('Repair stopped. No credentials/member data logged.', { code: error.code || error.name, reason: error.code ? 'Database rejected operation; inspect private evidence before retrying.' : error.message.split('\n')[0] });
  process.exitCode = 1;
});

export function exportWorkbook(rows, summary) { return workbookBytes(rows, summary); }
