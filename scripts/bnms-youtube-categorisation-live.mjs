import assert from 'node:assert/strict';
import { buildReport, TENANT_ID, COLLECTION_ADDITIONS } from './bnms-youtube-categorisation.mjs';

export const APPROVED_CHECKSUM = 'c9288b43a7a50706f29028c52a1b4d6228a1a45c24ef5d025fd13820b6162117';

export function approvedReport(workbook, snapshot) {
  assert.equal(workbook.checksum, APPROVED_CHECKSUM, 'Unreviewed workbook');
  for (const row of [...snapshot.resources, ...snapshot.categories]) {
    assert.equal(row.tenant_id, TENANT_ID, 'Wrong tenant');
  }
  const report = buildReport(workbook, snapshot.resources, snapshot.categories);
  assert.equal(report.summary.validLinkRows, 193, 'Mapping drift');
  assert.equal(report.summary.resolvedResources, 189, 'Resource matching drift');
  assert.equal(report.summary.unmatchedRows, 0, 'Unmatched resources require review');
  assert.deepEqual(report.rows.filter(r => r.status === 'blocked').map(r => [r.row, r.issues]), [
    [163, ['missing_or_malformed_video_link; no title fallback']],
  ]);
  assert.equal(report.rows.find(r => r.row === 324)?.status, 'ignored_type_only');
  assert.deepEqual(report.proposals.filter(p => p.sourceRows.length > 1).map(p => p.sourceRows),
    [[2, 23], [15, 39], [24, 43], [100, 114]]);
  const definition = report.categoryDefinitions[0];
  assert.ok(definition.additions.every(v => COLLECTION_ADDITIONS.includes(v)));
  return report;
}

export async function sqlSnapshot(client, lock = false) {
  const read = async table => (await client.query(
    `SELECT to_jsonb(r) AS record FROM public.${table} r WHERE tenant_id = $1 ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [TENANT_ID],
  )).rows.map(row => row.record);
  return { resources: await read('resource'), categories: await read('resource_category') };
}

export function verifyAfter(before, after, report) {
  const expected = structuredClone(before);
  for (const p of report.proposals) {
    if (p.proposedPatch) expected.resources.find(r => r.id === p.resourceId).subcategories = p.resulting.subcategories;
  }
  for (const d of report.categoryDefinitions) {
    if (d.additions.length) expected.categories.find(r => r.id === d.id).subcategories = d.resulting;
  }
  // All fields, all tenant rows, and counts: catches trigger side effects too.
  assert.deepEqual(after, expected, 'Unexpected changes outside approved classifications');
}

// Only this function writes; a dry run never invokes it. All updates either commit
// together or roll back. A lost COMMIT response is explicitly an unknown outcome.
export async function applyApproved({ client, workbook, before, journal }) {
  const report = approvedReport(workbook, before);
  let commitStarted = false;
  let writes = 0;
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const locked = await sqlSnapshot(client, true);
    assert.deepEqual(locked, before, 'Stale proposal: refresh before retrying');
    const changes = [
      ...report.categoryDefinitions.filter(d => d.additions.length).map(d => ({
        table: 'resource_category', id: d.id, before: d.current, after: d.resulting,
      })),
      ...report.proposals.filter(p => p.proposedPatch).map(p => ({
        table: 'resource', id: p.resourceId,
        before: before.resources.find(r => r.id === p.resourceId).subcategories,
        after: p.resulting.subcategories, sourceRows: p.sourceRows,
      })),
    ];
    for (const change of changes) {
      journal({ status: 'pending_transaction', ...change });
      const result = await client.query(
        `UPDATE public.${change.table} SET subcategories = $1::text[]
         WHERE id = $2 AND tenant_id = $3 AND subcategories IS NOT DISTINCT FROM $4::text[]
         RETURNING id, subcategories`,
        [change.after, change.id, TENANT_ID, change.before],
      );
      assert.equal(result.rowCount, 1, 'Conditional update failed');
      assert.deepEqual(result.rows[0].subcategories, change.after);
      writes++;
      journal({ status: 'verified_in_transaction', ...change });
    }
    const after = await sqlSnapshot(client);
    verifyAfter(before, after, report);
    const remaining = approvedReport(workbook, after);
    assert.equal(remaining.summary.classificationUpdates, 0);
    assert.equal(remaining.summary.categoryDefinitionAdditions, 0);
    journal({ status: 'commit_intent', writes });
    commitStarted = true;
    await client.query('COMMIT');
    journal({ status: 'committed', writes });
    return { writes, report, after };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    journal({ status: commitStarted ? 'commit_outcome_requires_reconciliation' : 'rolled_back',
      attemptedWrites: writes, confirmedWrites: commitStarted ? null : 0, error: error.message });
    throw error;
  }
}