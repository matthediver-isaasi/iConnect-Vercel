#!/usr/bin/env node
import pg from 'pg';
const { Client } = pg;

const databaseUrl = process.env.DEST_DATABASE_URL || process.env.DEV_DATABASE_URL || process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('Missing database URL (DEST_DATABASE_URL / DEV_DATABASE_URL / DATABASE_URL)');
  process.exit(1);
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

async function runSQL(sql, label) {
  const result = await client.query(sql);
  console.log(`[${label}] OK`, result.rowCount != null ? `(${result.rowCount} rows)` : '');
}

async function main() {
  await client.connect();
  console.log('Connected. Running migration...\n');

  await client.query('BEGIN');

  try {
    await runSQL(`
      ALTER TABLE complex_event_session
      ADD COLUMN IF NOT EXISTS complex_event_id UUID REFERENCES complex_event(id) ON DELETE CASCADE;
    `, '1. Add complex_event_id to sessions');

    await runSQL(`
      UPDATE complex_event_session s
      SET complex_event_id = t.complex_event_id
      FROM complex_event_track t
      WHERE s.complex_event_track_id = t.id
        AND s.complex_event_id IS NULL;
    `, '2. Backfill complex_event_id');

    await runSQL(`
      CREATE TABLE IF NOT EXISTS complex_event_session_track (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        complex_event_session_id UUID NOT NULL REFERENCES complex_event_session(id) ON DELETE CASCADE,
        complex_event_track_id UUID NOT NULL REFERENCES complex_event_track(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(complex_event_session_id, complex_event_track_id)
      );
    `, '3. Create junction table');

    await runSQL(`CREATE INDEX IF NOT EXISTS idx_session_track_session_id ON complex_event_session_track(complex_event_session_id);`, '4a. Index session_id');
    await runSQL(`CREATE INDEX IF NOT EXISTS idx_session_track_track_id ON complex_event_session_track(complex_event_track_id);`, '4b. Index track_id');
    await runSQL(`CREATE INDEX IF NOT EXISTS idx_session_track_tenant_id ON complex_event_session_track(tenant_id);`, '4c. Index tenant_id');

    await runSQL(`
      INSERT INTO complex_event_session_track (complex_event_session_id, complex_event_track_id, tenant_id)
      SELECT id, complex_event_track_id, tenant_id
      FROM complex_event_session
      WHERE complex_event_track_id IS NOT NULL
      ON CONFLICT (complex_event_session_id, complex_event_track_id) DO NOTHING;
    `, '5. Migrate existing links');

    await runSQL(`ALTER TABLE complex_event_session_track ENABLE ROW LEVEL SECURITY;`, '6. Enable RLS');
    await runSQL(`DROP POLICY IF EXISTS "service_role_all_session_track" ON complex_event_session_track;`, '7a. Drop old policy');
    await runSQL(`CREATE POLICY "service_role_all_session_track" ON complex_event_session_track FOR ALL TO service_role USING (true) WITH CHECK (true);`, '7b. Create RLS policy');

    await runSQL(`CREATE INDEX IF NOT EXISTS idx_session_event_id ON complex_event_session(complex_event_id);`, '8. Index event_id on sessions');
    await runSQL(`ALTER TABLE complex_event_session ALTER COLUMN complex_event_track_id DROP NOT NULL;`, '9. Make track_id nullable');

    await client.query('COMMIT');

    const r1 = await client.query('SELECT count(*) as cnt FROM complex_event_session');
    const r2 = await client.query('SELECT count(*) as cnt FROM complex_event_session_track');
    console.log(`\n=== Done === Sessions: ${r1.rows[0].cnt}, Junction rows: ${r2.rows[0].cnt}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed, rolled back:', err.message);
    throw err;
  }

  await client.end();
}

main().catch(err => { console.error(err); client.end(); process.exit(1); });
