/**
 * Backfill tenant_id for members orphaned by the tenant-less import bug.
 *
 * The old import path created members with tenant_id = NULL, so they were
 * invisible to every tenant-scoped view (e.g. /members). This script assigns
 * those orphaned members to the affected tenant.
 *
 * Safety:
 *  - DRY RUN by default. Pass --apply to actually write.
 *  - Restricted to a single tenant (default slug "bnms"); pass --tenant=<slug-or-uuid>.
 *  - Only touches members with tenant_id IS NULL.
 *  - Skips any orphan whose email already exists in the target tenant
 *    (would violate the (email, tenant_id) unique constraint).
 *  - For duplicate emails within the orphan set, assigns only the earliest row
 *    (by created_on then id) and skips the rest.
 *
 * Usage:
 *   node scripts/backfill-import-tenant.mjs                 # dry run, tenant=bnms
 *   node scripts/backfill-import-tenant.mjs --tenant=bnms   # dry run
 *   node scripts/backfill-import-tenant.mjs --apply         # commit changes
 */
import pg from 'pg';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const tenantArg = (args.find((a) => a.startsWith('--tenant=')) || '--tenant=bnms').split('=')[1];

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function run() {
  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    // Resolve target tenant.
    let tenantId = tenantArg;
    let tenantSlug = tenantArg;
    if (UUID_RE.test(tenantArg)) {
      const { rows } = await client.query('SELECT id, slug FROM tenant WHERE id = $1', [tenantArg]);
      if (!rows.length) throw new Error(`No tenant with id ${tenantArg}`);
      tenantSlug = rows[0].slug;
    } else {
      const { rows } = await client.query('SELECT id, slug FROM tenant WHERE slug = $1', [tenantArg]);
      if (!rows.length) throw new Error(`No tenant with slug "${tenantArg}"`);
      tenantId = rows[0].id;
    }
    console.log(`Target tenant: ${tenantSlug} (${tenantId})`);
    console.log(`Mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no changes)'}\n`);

    // Profile the orphan set.
    const { rows: counts } = await client.query(`
      WITH orphans AS (
        SELECT id, lower(trim(email)) AS el, email,
               row_number() OVER (PARTITION BY lower(trim(email)) ORDER BY created_on NULLS LAST, id) AS rn
        FROM member
        WHERE tenant_id IS NULL AND email IS NOT NULL AND trim(email) <> ''
      )
      SELECT
        (SELECT count(*) FROM member WHERE tenant_id IS NULL) AS total_orphans,
        (SELECT count(*) FROM member WHERE tenant_id IS NULL AND (email IS NULL OR trim(email) = '')) AS null_email,
        count(*) FILTER (WHERE rn > 1) AS dup_within_set,
        count(*) FILTER (
          WHERE rn = 1 AND EXISTS (
            SELECT 1 FROM member b WHERE b.tenant_id = $1 AND lower(trim(b.email)) = orphans.el
          )
        ) AS collide_existing,
        count(*) FILTER (
          WHERE rn = 1 AND NOT EXISTS (
            SELECT 1 FROM member b WHERE b.tenant_id = $1 AND lower(trim(b.email)) = orphans.el
          )
        ) AS eligible
      FROM orphans
    `, [tenantId]);

    const c = counts[0];
    console.log('Orphan profile (members with tenant_id IS NULL):');
    console.log(`  total orphans            : ${c.total_orphans}`);
    console.log(`  eligible to assign       : ${c.eligible}`);
    console.log(`  skipped (dup within set) : ${c.dup_within_set}`);
    console.log(`  skipped (email exists in target tenant): ${c.collide_existing}`);
    console.log(`  skipped (null/empty email): ${c.null_email}\n`);

    if (!APPLY) {
      console.log('Dry run complete. Re-run with --apply to assign the eligible members.');
      return;
    }

    const { rowCount } = await client.query(`
      WITH ranked AS (
        SELECT id, lower(trim(email)) AS el,
               row_number() OVER (PARTITION BY lower(trim(email)) ORDER BY created_on NULLS LAST, id) AS rn
        FROM member
        WHERE tenant_id IS NULL AND email IS NOT NULL AND trim(email) <> ''
      ),
      eligible AS (
        SELECT r.id FROM ranked r
        WHERE r.rn = 1
          AND NOT EXISTS (
            SELECT 1 FROM member b WHERE b.tenant_id = $1 AND lower(trim(b.email)) = r.el
          )
      )
      UPDATE member SET tenant_id = $1 WHERE id IN (SELECT id FROM eligible)
    `, [tenantId]);

    console.log(`Assigned ${rowCount} member(s) to tenant ${tenantSlug}.`);

    const { rows: remaining } = await client.query('SELECT count(*) AS n FROM member WHERE tenant_id IS NULL');
    console.log(`Remaining orphaned members (tenant_id IS NULL): ${remaining[0].n}`);
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
