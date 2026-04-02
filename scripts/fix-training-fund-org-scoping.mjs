import pg from 'pg';
const { Client } = pg;

const client = new Client({
  connectionString: process.env.DEST_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  await client.query('BEGIN');

  const lseId = 'a997be90-c972-4179-8cd5-9d28b6e02646';
  const gfiId = 'ccbbbd4d-12e8-4e9e-b49e-cd29979623ae';
  const misattributedTxId = '1529b8c0-b53b-41be-b159-1cd76d488cfa';

  console.log('=== Training Fund Data Correction ===');
  console.log('Reassigning misattributed transaction from GFI to LSE...');

  const updateTx = await client.query(
    'UPDATE training_fund_transaction SET organization_id = $1 WHERE id = $2 RETURNING id, organization_id',
    [lseId, misattributedTxId]
  );
  console.log('Reassigned transaction:', updateTx.rows[0]?.id, '-> org:', updateTx.rows[0]?.organization_id);

  for (const orgId of [lseId, gfiId]) {
    const txs = await client.query(
      'SELECT type, amount FROM training_fund_transaction WHERE organization_id = $1',
      [orgId]
    );
    let balance = 0;
    for (const tx of txs.rows) {
      if (tx.type === 'add') balance += parseFloat(tx.amount);
      else balance -= parseFloat(tx.amount);
    }
    await client.query('UPDATE organization SET training_fund_balance = $1 WHERE id = $2', [balance, orgId]);

    const org = await client.query('SELECT name FROM organization WHERE id = $1', [orgId]);
    console.log(`Updated ${org.rows[0]?.name}: balance = ${balance}`);
  }

  const result = await client.query(`
    SELECT o.id, o.name,
      COALESCE(o.training_fund_balance::numeric, 0) as stored,
      COALESCE(SUM(CASE WHEN t.type = 'add' THEN t.amount::numeric ELSE -t.amount::numeric END), 0) as computed
    FROM organization o
    LEFT JOIN training_fund_transaction t ON t.organization_id = o.id
    GROUP BY o.id, o.name, o.training_fund_balance
    HAVING COALESCE(o.training_fund_balance::numeric, 0) != 0 OR COUNT(t.id) > 0
  `);
  let mismatches = 0;
  for (const row of result.rows) {
    if (Math.abs(parseFloat(row.stored) - parseFloat(row.computed)) > 0.01) {
      mismatches++;
      console.log('MISMATCH:', row.name, 'stored:', row.stored, 'computed:', row.computed);
    }
  }
  console.log(`\nVerification: ${result.rows.length} orgs checked, ${mismatches} mismatches`);

  if (mismatches === 0) {
    await client.query('COMMIT');
    console.log('Data correction committed successfully.');
  } else {
    await client.query('ROLLBACK');
    console.log('ROLLED BACK due to remaining mismatches.');
  }

  await client.end();
}

run().catch(e => { console.error(e); process.exit(1); });
