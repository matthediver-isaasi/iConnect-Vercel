/**
 * Separate opt-in runner. The original validator remains GET-only.
 * node scripts/apply-bnms-youtube-categorisation.mjs [--apply]
 * On failure rerun without flags to review fresh state, then --apply to resume.
 * Never restore the before-state wholesale: that could revert unrelated edits.
 */
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { INPUT, readWorkbook, readAll, checksum } from './bnms-youtube-categorisation.mjs';
import { approvedReport, applyApproved, sqlSnapshot, verifyAfter } from './bnms-youtube-categorisation-live.mjs';
import assert from 'node:assert/strict';
import { destinationConfig, durableFile, writeComplete, syncDirectory } from './bnms-youtube-categorisation-io.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--apply', '--dry-run'].includes(args[0]))) {
    throw Error('Only --apply or --dry-run accepted');
  }
  const live = args[0] === '--apply';
  const workbook = readWorkbook(readFileSync(INPUT));
  const url = process.env.DEST_SUPABASE_URL, key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) throw Error('Destination credentials required; no fallback');
  const connection = destinationConfig(url, process.env.DEST_DATABASE_URL);
  const rest = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => {
      if ((init?.method || 'GET').toUpperCase() !== 'GET') throw Error('Read transport rejects writes');
      return fetch(input, init);
    } } });
  const resources = await readAll(rest, 'resource', '*');
  const categories = await readAll(rest, 'resource_category', '*');
  const before = { resources: resources.rows, categories: categories.rows };
  const report = approvedReport(workbook, before);
  const dir = `.local/bnms-youtube-categorisation/runs/${new Date().toISOString().replaceAll(':', '-')}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const directory of [dir, `${dir}/..`, `${dir}/../..`, '.local', '.']) syncDirectory(directory);
  const save = (name, value) => durableFile(`${dir}/${name}.json`, JSON.stringify(value, null, 2));
  save('before', before);
  save('proposal', { ...report, snapshotChecksum: checksum(JSON.stringify(before)),
    coverage: { resources: resources.pages, categories: categories.pages }, live });
  console.log(JSON.stringify({ auditDirectory: dir, live, ...report.summary }));
  if (!live) return;
  // Public provider CA, downloaded over HTTPS and checksum-pinned. Never
  // disable certificate/hostname verification to work around a private root.
  const caResponse = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!caResponse.ok) throw Error('Could not load trusted Supabase CA');
  const ca = await caResponse.text();
  assert.equal(checksum(ca), '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7', 'Unexpected Supabase CA');
  const client = new pg.Client({ ...connection, ssl: { rejectUnauthorized: true, ca } });
  const fd = openSync(`${dir}/journal.jsonl`, 'ax', 0o600);
  syncDirectory(dir);
  const journal = entry => writeComplete(fd, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  try {
    await client.connect();
    // Compare both endpoints before writes, including every tenant row and field.
    const result = await applyApproved({ client, workbook, before, journal });
    const after = await sqlSnapshot(client);
    verifyAfter(before, after, result.report);
    save('after', after);
    const fresh = approvedReport(workbook, after);
    const replay = await applyApproved({ client, workbook, before: after, journal });
    assert.equal(replay.writes, 0, 'Replay must make zero writes');
    save('verification', { inputChecksum: workbook.checksum, summary: fresh.summary,
      appliedResources: report.summary.classificationUpdates,
      unchangedResources: report.summary.unchangedResources,
      collectionAdditions: report.categoryDefinitions[0].additions,
      confirmedWrites: result.writes, replayWrites: replay.writes,
      preservedAllOtherFields: true, resourceCountBefore: before.resources.length,
      resourceCountAfter: after.resources.length,
      skippedRows: report.rows.filter(r => r.status === 'blocked' || r.status.startsWith('ignored')) });
    console.log(JSON.stringify({ confirmedWrites: result.writes, replayWrites: replay.writes, verified: true }));
  } finally {
    closeSync(fd);
    await client.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });