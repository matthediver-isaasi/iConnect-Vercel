import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

async function run() {
  await client.connect();
  console.log('Connected to database');

  await client.query(`
    ALTER TABLE email_campaign 
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES member(id);
  `);
  console.log('Ensured cancelled_at and cancelled_by columns exist on email_campaign');

  const { rows: colInfo } = await client.query(`
    SELECT data_type, udt_name FROM information_schema.columns 
    WHERE table_name = 'email_campaign_recipient' AND column_name = 'status'
  `);

  if (colInfo.length > 0 && colInfo[0].data_type === 'USER-DEFINED') {
    const checkEnum = await client.query(`
      SELECT 1 FROM pg_enum 
      WHERE enumlabel = 'cancelled' 
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = $1)
      LIMIT 1
    `, [colInfo[0].udt_name]);

    if (checkEnum.rows.length === 0) {
      try {
        await client.query(`ALTER TYPE ${colInfo[0].udt_name} ADD VALUE IF NOT EXISTS 'cancelled'`);
        console.log('Added cancelled value to recipient status enum');
      } catch (e) {
        console.log('Could not add cancelled to enum:', e.message);
      }
    } else {
      console.log('cancelled value already exists in recipient status enum');
    }
  } else {
    console.log('Recipient status is varchar — cancelled value is automatically supported');
  }

  await client.end();
  console.log('Migration complete');
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
