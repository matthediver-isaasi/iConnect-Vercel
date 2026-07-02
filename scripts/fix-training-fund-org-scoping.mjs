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

  const lseBefore = await client.query('SELECT name, training_fund_balance FROM organization WHERE id = $1', [lseId]);
  const gfiBefore = await client.query('SELECT name, training_fund_balance FROM organization WHERE id = $1', [gfiId]);
  console.log('BEFORE - LSE:', lseBefore.rows[0]?.name, 'balance:', lseBefore.rows[0]?.training_fund_balance);
  console.log('BEFORE - GFI:', gfiBefore.rows[0]?.name, 'balance:', gfiBefore.rows[0]?.training_fund_balance);

  console.log('\nReassigning misattributed transaction from GFI to LSE...');
  const updateTx = await client.query(
    'UPDATE training_fund_transaction SET organization_id = $1 WHERE id = $2 RETURNING id, organization_id',
    [lseId, misattributedTxId]
  );

  if (updateTx.rowCount !== 1) {
    await client.query('ROLLBACK');
    console.error('ABORT: Expected to update exactly 1 transaction row, got', updateTx.rowCount);
    process.exit(1);
  }
  console.log('Reassigned transaction:', updateTx.rows[0].id, '-> org:', updateTx.rows[0].organization_id);

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
    const updateOrg = await client.query(
      'UPDATE organization SET training_fund_balance = $1 WHERE id = $2 RETURNING name, training_fund_balance',
      [balance, orgId]
    );
    console.log(`Updated ${updateOrg.rows[0]?.name}: balance = ${updateOrg.rows[0]?.training_fund_balance}`);
  }

  const verify = await client.query(`
    SELECT o.name,
      COALESCE(o.training_fund_balance::numeric, 0) as stored,
      COALESCE(SUM(CASE WHEN t.type = 'add' THEN t.amount::numeric ELSE -t.amount::numeric END), 0) as computed
    FROM organization o
    LEFT JOIN training_fund_transaction t ON t.organization_id = o.id
    WHERE o.id IN ($1, $2)
    GROUP BY o.id, o.name, o.training_fund_balance
  `, [lseId, gfiId]);

  let ok = true;
  for (const row of verify.rows) {
    const match = Math.abs(parseFloat(row.stored) - parseFloat(row.computed)) < 0.01;
    console.log(`\nVERIFY ${row.name}: stored=${row.stored}, computed=${row.computed}, match=${match}`);
    if (!match) ok = false;
  }

  if (ok) {
    await client.query('COMMIT');
    console.log('\nData correction committed successfully.');
  } else {
    await client.query('ROLLBACK');
    console.error('\nROLLED BACK: target org balances still mismatched after correction.');
    process.exit(1);
  }

  await client.end();
}

run().catch(e => { console.error(e); process.exit(1); });
