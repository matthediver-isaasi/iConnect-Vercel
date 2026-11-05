import assert from 'node:assert/strict';
import { connectDestination } from './annual-meeting-destination.mjs';

// Owner-authorized member-link repair only. Historical submissions/bookings
// and both organisation records are deliberately retained.
const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const RETAIN = '7f16328d-e692-4671-873a-453464071eef';
const DUPLICATE = '37e06c99-b2b6-46d4-b47c-21f9b8f19710';
const apply = process.argv.includes('--apply');
const db = await connectDestination();
try {
  await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout = '5s'");
  await db.query("SET LOCAL statement_timeout = '30s'");
  const { rows: organizations } = await db.query(
    `SELECT id,tenant_id,name,status,created_at FROM organization
     WHERE id=ANY($1::uuid[]) ORDER BY id${apply ? ' FOR UPDATE' : ''}`, [[RETAIN, DUPLICATE]]);
  assert.equal(organizations.length, 2, 'Both expected organisation records must exist');
  for (const organization of organizations) {
    assert.equal(organization.tenant_id, TENANT);
    assert.equal(organization.name, 'Zombie Organisation');
    assert.equal(organization.status, 'active');
  }
  assert.ok(organizations.find(o => o.id === RETAIN).created_at
    < organizations.find(o => o.id === DUPLICATE).created_at, 'Retained record must be older');
  const { rows: members } = await db.query(
    `SELECT to_jsonb(m) AS record FROM member m
     WHERE organization_id=ANY($1::uuid[]) ORDER BY id${apply ? ' FOR UPDATE' : ''}`,
    [[RETAIN, DUPLICATE]]);
  assert.ok(members.every(({ record }) => record.tenant_id === TENANT), 'Cross-tenant member reference');
  const moving = members.filter(({ record }) => record.organization_id === DUPLICATE);
  const retained = members.filter(({ record }) => record.organization_id === RETAIN);
  // Exact inspected cohort or an idempotent replay; changed populations need
  // fresh inspection rather than silently expanding the repair.
  assert.ok((moving.length === 7 && retained.length === 6)
    || (moving.length === 0 && retained.length === 13), 'Member population changed; inspect before repair');
  const { rows: [{ count: relationshipCount }] } = await db.query(
    `SELECT count(*)::int FROM custom_object_relationship
     WHERE source_record_id=$1 OR target_record_id=$1`, [DUPLICATE]);
  assert.equal(relationshipCount, 0, 'Duplicate has additional relationships requiring separate reconciliation');
  let changed = 0;
  if (apply && moving.length) {
    const result = await db.query(
      `UPDATE member SET organization_id=$1
       WHERE tenant_id=$2 AND organization_id=$3 AND id=ANY($4::uuid[])`,
      [RETAIN, TENANT, DUPLICATE, moving.map(({ record }) => record.id)]);
    assert.equal(result.rowCount, moving.length);
    changed = result.rowCount;
    const { rows: after } = await db.query(
      'SELECT to_jsonb(m) AS record FROM member m WHERE id=ANY($1::uuid[]) ORDER BY id',
      [members.map(({ record }) => record.id)]);
    assert.equal(after.length, members.length);
    for (let index = 0; index < members.length; index++) {
      // updated_at may be maintained by a database trigger; all other fields
      // including login, role, group, billing and consent must stay unchanged.
      const { updated_at: beforeTimestamp, ...before } = members[index].record;
      const { updated_at: afterTimestamp, ...current } = after[index].record;
      const expected = { ...before, organization_id: RETAIN };
      if (before.organization_id === DUPLICATE) {
        // Existing database trigger advances the invitation revision on every
        // member update. Preserve that fencing behavior rather than bypass it.
        expected.survey_invitation_revision = before.survey_invitation_revision + 1;
      }
      assert.ok(JSON.stringify(current) === JSON.stringify(expected),
        'Unexpected member field change; transaction rolled back');
    }
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({
    applied: apply, changed, alreadyConsolidated: moving.length === 0,
    retainedOrganizationId: RETAIN, duplicateOrganizationId: DUPLICATE,
    retainedPrimaryMembers: apply ? members.length : retained.length,
    duplicatePrimaryMembers: apply ? 0 : moving.length,
    historicalReferences: 'unchanged', organizationRecords: 'unchanged',
  }));
} catch (error) {
  await db.query('ROLLBACK');
  // Do not print member snapshots in assertion diagnostics.
  console.error(JSON.stringify({ applied: false, error: error.message }));
  process.exitCode = 1;
} finally {
  await db.end();
}
