import pg from 'pg';
const { Client } = pg;

async function runMigration() {
  const destUrl = process.env.DEST_DATABASE_URL;

  if (!destUrl) {
    console.error('DEST_DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  const client = new Client({
    connectionString: destUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Connecting to destination database...');
    await client.connect();
    console.log('Connected successfully');

    const checkResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'submission_document'
      AND column_name IN ('public_file_url', 'public_storage_path')
    `);

    const existing = new Set(checkResult.rows.map(r => r.column_name));

    if (!existing.has('public_file_url')) {
      console.log('Adding public_file_url column...');
      await client.query(`ALTER TABLE submission_document ADD COLUMN public_file_url TEXT`);
      console.log('Added public_file_url');
    } else {
      console.log('public_file_url already exists');
    }

    if (!existing.has('public_storage_path')) {
      console.log('Adding public_storage_path column...');
      await client.query(`ALTER TABLE submission_document ADD COLUMN public_storage_path TEXT`);
      console.log('Added public_storage_path');
    } else {
      console.log('public_storage_path already exists');
    }

    const verifyResult = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'submission_document'
      AND column_name IN ('public_file_url', 'public_storage_path')
      ORDER BY column_name
    `);

    console.log('\nVerification:');
    verifyResult.rows.forEach(row => {
      console.log(`  ${row.column_name}: ${row.data_type} (nullable: ${row.is_nullable})`);
    });

    console.log('\nMigration complete');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
