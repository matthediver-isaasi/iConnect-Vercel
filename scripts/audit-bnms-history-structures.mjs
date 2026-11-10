// Read-only destination audit. Prints aggregate evidence categories, never member data.
import assert from 'node:assert/strict';
import { connectDestination } from './annual-meeting-destination.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const db = await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout = '30s'");
  assert.equal((await db.query('SELECT slug FROM tenant WHERE id=$1', [tenant])).rows[0]?.slug, 'bnms');
  const configs = (await db.query(
    'SELECT id,name,effective_to FROM membership_tier_config WHERE tenant_id=$1 ORDER BY id LIMIT 1000',
    [tenant],
  )).rows;
  assert.ok(configs.length < 1000, 'Configuration limit reached');
  const byId = new Map(configs.map(row => [row.id, row]));
  const groups = new Map();
  const missingMembers = new Set();
  const snapshotMembers = new Set();
  let cursor = null, total = 0;
  for (;;) {
    const rows = (await db.query(`SELECT id,member_id,config_id,tier_label,commitment_snapshot,notes
      FROM member_membership_history WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2)
      ORDER BY id LIMIT 200`, [tenant, cursor])).rows;
    if (!rows.length) break;
    for (const row of rows) {
      let notes = row.notes;
      if (typeof notes === 'string') {
        try { notes = JSON.parse(notes); } catch { notes = null; }
      }
      const snapshot = row.commitment_snapshot;
      const name = snapshot?.structure_name || snapshot?.config?.name;
      const config = byId.get(snapshot?.config?.id || snapshot?.config_id || row.config_id);
      const reconstructed = notes?.source === 'bnms_expiry_gap_reconstruction'
        && notes.structureAuthority === 'current_member_class_mapping_not_original_purchase_configuration'
        && typeof notes.reconstructedStructureName === 'string';
      const category = name
        ? (snapshot?.source === 'bnms_five_member_reconstruction_v1'
          ? 'unsupported_classification_snapshot_review'
          : config && config.name === name
            ? (config.effective_to ? 'saved_snapshot_retired_config' : 'saved_snapshot_matching_config')
            : 'saved_snapshot_unresolved_provenance_review')
        : reconstructed ? 'approved_reconstruction_not_purchase_snapshot'
          : row.config_id ? 'missing_name_config_id_only'
            : row.tier_label?.trim() ? 'missing_structure_classification_only' : 'missing_structure_and_classification';
      if (!groups.has(category)) groups.set(category, { histories: 0, members: new Set() });
      const group = groups.get(category);
      group.histories++;
      group.members.add(row.member_id);
      if (category.startsWith('missing_')) missingMembers.add(row.member_id);
      if (category.startsWith('saved_snapshot_')) snapshotMembers.add(row.member_id);
      total++;
    }
    cursor = rows.at(-1).id;
  }
  const expected = (await db.query(
    'SELECT count(*)::int histories,count(distinct member_id)::int members FROM member_membership_history WHERE tenant_id=$1',
    [tenant],
  )).rows[0];
  assert.equal(total, expected.histories, 'Incomplete history scan');
  const organisation = (await db.query(
    'SELECT count(*)::int histories,count(distinct organization_id)::int organisations FROM organisation_membership_history WHERE tenant_id=$1',
    [tenant],
  )).rows[0];
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(), destination: 'lvmzliemqnieeoruhkik',
    total: expected, configurations: configs.length, organisation,
    missingStructureDistinctMembers: missingMembers.size,
    savedSnapshotDistinctMembers: snapshotMembers.size,
    categories: Object.fromEntries([...groups].map(([name, value]) => [
      name, { histories: value.histories, members: value.members.size },
    ])), writes: 0,
  }, null, 2));
  await db.query('ROLLBACK');
} finally {
  await db.end();
}
