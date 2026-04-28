import pg from 'pg';

const databaseUrl = process.env.DEST_DATABASE_URL;

async function run() {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('Adding email template columns to article_brief...');

  const queries = [
    `ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS case_study_email_template_id UUID REFERENCES email_template(id) ON DELETE SET NULL`,
    `ALTER TABLE article_brief ADD COLUMN IF NOT EXISTS copyright_email_template_id UUID REFERENCES email_template(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_article_brief_case_study_email_template ON article_brief(case_study_email_template_id)`,
    `CREATE INDEX IF NOT EXISTS idx_article_brief_copyright_email_template ON article_brief(copyright_email_template_id)`,
  ];

  for (const q of queries) {
    try {
      await client.query(q);
      console.log('OK:', q.substring(0, 100));
    } catch (err) {
      console.error('Error:', err.message, 'for query:', q.substring(0, 100));
    }
  }

  console.log('Done!');
  await client.end();
}

run().catch(err => { console.error(err); process.exit(1); });
