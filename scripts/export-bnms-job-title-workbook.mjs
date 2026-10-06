import fs from 'node:fs';
import assert from 'node:assert/strict';
import { connectDestination } from './annual-meeting-destination.mjs';
import { DIRECTORY, savePrivate } from './audit-bnms-job-titles.mjs';
import { TENANT, hash, workbookBytes, parseCorrections } from './bnms-job-title-repair-core.mjs';
import { liveSchema, readMembers } from './bnms-job-title-repair-db.mjs';

process.on('uncaughtException', () => { console.error('Export stopped; reconcile the private audit without printing member records.'); process.exitCode = 1; });
const audit = JSON.parse(fs.readFileSync(`${DIRECTORY}/audit.json`));
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal((await db.query('select name from tenant where id=$1', [TENANT])).rows[0]?.name, 'BNMS');
  const members = await readMembers(db);
  assert.equal(members.length, audit.length, 'Member population changed; re-audit before exporting');
  const rows = [], concurrentActivity = [];
  for (const row of audit) {
    const member = members.find(m => m.id === row.member.id);
    assert.ok(member);
    if (row.classification === 'confirmed-misplaced') {
      assert.deepEqual(member, { ...row.member, job_title: null, updated_at: member.updated_at, survey_invitation_revision: row.member.survey_invitation_revision + 1 });
    } else {
      const changed = Object.keys(member).filter(k => JSON.stringify(member[k]) !== JSON.stringify(row.member[k]));
      // Separately reviewed live activity during this audit is not a repair write.
      // All identity, title, profile, financial/access/consent fields remain exact.
      assert.ok(changed.every(k => ['last_activity', 'updated_at', 'survey_invitation_revision'].includes(k)), 'Profile drift requires individual reconciliation');
      if (changed.length) concurrentActivity.push({ id: member.id, changed });
    }
    if (['blank', 'ambiguous', 'confirmed-misplaced'].includes(row.classification)) rows.push({
      member,
      reason: row.classification === 'confirmed-misplaced' ? 'Imported note preserved verbatim as a member note; no genuine source title recovered.' : row.reason,
    });
  }
  const summary = {
    'Members audited (all statuses)': audit.length,
    'Valid titles preserved': audit.filter(r => r.classification === 'valid').length,
    'Notes preserved / titles cleared': audit.filter(r => r.classification === 'confirmed-misplaced').length,
    'Titles recovered': 0,
    'Remaining blank titles': members.filter(m => !m.job_title?.trim()).length,
    'Ambiguous titles unchanged': audit.filter(r => r.classification === 'ambiguous').length,
    'Manual completion rows': rows.length,
    'Initial blank titles': audit.filter(r => r.classification === 'blank').length,
    'Migrations needed or applied': 'None',
    'Concurrent activity-only changes (preserved)': concurrentActivity.length,
  };
  const manifest = { mode: 'returned', tenant: TENANT, exportedAt: new Date().toISOString(), schemaHash: hash(await liveSchema(db)), rows };
  savePrivate('manual-manifest.json', manifest);
  savePrivate('completion-summary.json', { ...summary, manifestHash: hash(manifest), unaffectedProfileFieldsVerified: true, concurrentActivity, limitations: 'No historical source with reliable genuine titles was recovered. July workbook has no UUID/email matches to BNMS; September member export is headers-only. Other retained BNMS cohort imports have no Job Title column. Import history is incomplete (three retained jobs, no Job Title mapping). Mixed and unconfirmed identities remain unchanged. Occupation was never substituted.' });
  const bytes = workbookBytes(rows, summary);
  assert.deepEqual(parseCorrections(bytes, rows), [], 'Blank workbook must propose zero writes');
  fs.writeFileSync(`${DIRECTORY}/BNMS-job-titles-for-completion.xlsx`, bytes, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ summary, manifestHash: hash(manifest), unchangedFieldsVerified: true, blankWorkbookWrites: 0 }));
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
