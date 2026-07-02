import pg from 'pg';

const databaseUrl = process.env.DEST_DATABASE_URL;
if (!databaseUrl) {
  console.error('DEST_DATABASE_URL is not set');
  process.exit(1);
}

async function run() {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const before = await client.query(
    `SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='zoho_crm_sync_log'`
  );
  if (before.rowCount > 0) {
    console.log('zoho_crm_sync_log is already in supabase_realtime publication. Nothing to do.');
    await client.end();
    return;
  }

  console.log('Adding zoho_crm_sync_log to supabase_realtime publication...');
  await client.query(`ALTER PUBLICATION supabase_realtime ADD TABLE zoho_crm_sync_log`);

  const after = await client.query(
    `SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='zoho_crm_sync_log'`
  );
  if (after.rowCount === 0) {
    throw new Error('Verification failed: zoho_crm_sync_log not found in publication after ALTER');
  }

  console.log('Done. zoho_crm_sync_log is now published for realtime subscribers.');
  await client.end();
}

run().catch(err => { console.error(err); process.exit(1); });
