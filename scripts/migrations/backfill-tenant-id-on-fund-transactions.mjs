import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DEST_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  console.log('Connected to database');

  const tfResult = await client.query(`
    UPDATE training_fund_transaction t
    SET tenant_id = o.tenant_id
    FROM organization o
    WHERE t.organization_id = o.id
      AND t.tenant_id IS NULL
      AND o.tenant_id IS NOT NULL
    RETURNING t.id, t.type, t.amount, t.reason, o.name as org_name, o.tenant_id as new_tenant_id
  `);
  console.log(`\nBackfilled tenant_id on ${tfResult.rowCount} training_fund_transaction(s):`);
  for (const r of tfResult.rows) {
    console.log(`  [${r.type}] £${r.amount} for ${r.org_name} -> tenant_id: ${r.new_tenant_id}`);
  }

  const vtResult = await client.query(`
    UPDATE voucher_transaction vt
    SET tenant_id = o.tenant_id
    FROM organization o
    WHERE vt.organization_id = o.id
      AND vt.tenant_id IS NULL
      AND o.tenant_id IS NOT NULL
    RETURNING vt.id, vt.type, vt.amount, vt.booking_reference, vt.event_title, o.name as org_name, o.tenant_id as new_tenant_id
  `);
  console.log(`\nBackfilled tenant_id on ${vtResult.rowCount} voucher_transaction(s):`);
  for (const r of vtResult.rows) {
    console.log(`  [${r.type}] £${r.amount} for ${r.org_name} (${r.event_title}) -> tenant_id: ${r.new_tenant_id}`);
  }

  const verifyTf = await client.query(`SELECT COUNT(*) as c FROM training_fund_transaction WHERE tenant_id IS NULL`);
  const verifyVt = await client.query(`SELECT COUNT(*) as c FROM voucher_transaction WHERE tenant_id IS NULL`);
  console.log(`\nRemaining NULL tenant_id: training_fund_transaction=${verifyTf.rows[0].c}, voucher_transaction=${verifyVt.rows[0].c}`);

  await client.end();
  console.log('\nDone');
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
