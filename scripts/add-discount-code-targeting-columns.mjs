import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const databaseUrl = process.env.DEST_DATABASE_URL;

async function run() {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('Adding member_id, role_id, member_group_id columns to discount_code table...');

  const queries = [
    `ALTER TABLE discount_code ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES member(id) ON DELETE SET NULL`,
    `ALTER TABLE discount_code ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES role(id) ON DELETE SET NULL`,
    `ALTER TABLE discount_code ADD COLUMN IF NOT EXISTS member_group_id UUID REFERENCES member_group(id) ON DELETE SET NULL`,
    `ALTER TABLE discount_code_usage ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES member(id) ON DELETE SET NULL`,
  ];

  for (const q of queries) {
    try {
      await client.query(q);
      console.log('OK:', q.substring(0, 80));
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log('Already exists, skipping:', q.substring(0, 80));
      } else {
        console.error('Error:', err.message, 'for query:', q.substring(0, 80));
      }
    }
  }

  console.log('Done!');
  await client.end();
}

run().catch(err => { console.error(err); process.exit(1); });
