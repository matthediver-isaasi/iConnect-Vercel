// Read-only destination catalog verification. Never reads member/profile data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';
import { directorySchema } from '../api/public/directory-schema-contract.mjs';
import { createOrganizationSnapshotAdapter } from '../api/_lib/organizationCarouselSnapshot.js';

const db = await connectDestination();
try {
  await db.query("BEGIN READ ONLY; SET LOCAL statement_timeout = '15s'");
  const { rows } = await db.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name = ANY($1::text[])`, [Object.keys(directorySchema)]);
  for (const [table, columns] of Object.entries(directorySchema)) {
    const actual = new Set(rows.filter(row => row.table_name === table).map(row => row.column_name));
    for (const column of columns.split(' ')) assert.ok(actual.has(column), `${table}.${column} absent`);
  }
  for (const column of ['slug', 'city', 'country']) {
    assert.ok(!rows.some(row => row.table_name === 'organization' && row.column_name === column));
  }
  const { rows: functions } = await db.query(`SELECT prosrc FROM pg_proc
    WHERE oid = 'public.organization_carousel_snapshot(uuid,text,text,text)'::regprocedure`);
  const migration = await readFile(new URL('../supabase/migrations/202610190002_organization_carousel_snapshot.sql', import.meta.url), 'utf8');
  assert.equal(functions[0].prosrc.trim(), migration.split('$function$')[1].trim(), 'Live snapshot body differs');
  const tenantId = '00000000-0000-0000-0000-000000000000';
  const { rows: snapshots } = await db.query(`SELECT public.organization_carousel_snapshot($1,'primary-organization') AS snapshot`, [tenantId]);
  const snapshot = snapshots[0].snapshot;
  createOrganizationSnapshotAdapter(snapshot, tenantId);
  assert.equal(snapshot.organization.length, 0);
  console.log(JSON.stringify({
    destination: PROJECT, readOnly: true, tablesVerified: Object.keys(directorySchema),
    absentOrganizationColumns: ['slug', 'city', 'country'], memberLinkedinPresent: true,
    consentColumnPresent: rows.some(row => row.table_name === 'dynamic_directory' && row.column_name === 'public_carousel_enabled'),
    liveSnapshotBodyMatchesMigration: true, emptyTenantSnapshotExecuted: true,
    migrationsApplied: [],
  }, null, 2));
} finally {
  await db.query('ROLLBACK');
  await db.end();
}
