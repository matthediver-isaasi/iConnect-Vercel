import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DEST_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  console.log('Connected to database');

  const before = await client.query(`
    SELECT COUNT(*)::int AS c
    FROM training_fund_transaction
    WHERE type = 'booking_usage' AND booking_id IS NULL
  `);
  console.log(`Booking-usage transactions missing booking_id (before): ${before.rows[0].c}`);

  // Reasons look like:
  //   "Event booking: <title> (OOE-1777026430548-KAU...)"
  //   "Complex event booking: <title> (CEB-XXXXXXXX)"
  // Pull out the trailing reference inside the final pair of parentheses.

  // Step 1: exact booking_reference match (single-attendee one-off bookings)
  const ooeExact = await client.query(`
    UPDATE training_fund_transaction t
    SET booking_id = b.id::text
    FROM booking b
    WHERE t.type = 'booking_usage'
      AND t.booking_id IS NULL
      AND (t.tenant_id IS NULL OR b.tenant_id IS NULL OR b.tenant_id = t.tenant_id)
      AND b.booking_reference = SUBSTRING(t.reason FROM '\\((OOE-[A-Za-z0-9]+-[A-Za-z0-9]+)\\)\\s*$')
    RETURNING t.id, t.amount, b.booking_reference
  `);
  console.log(`\nLinked ${ooeExact.rowCount} one-off (OOE-) booking transaction(s) via exact reference:`);
  for (const r of ooeExact.rows) {
    console.log(`  tx ${r.id} -> ${r.booking_reference} (£${r.amount})`);
  }

  // Step 2: match against the first attendee for multi-attendee bookings
  // (booking rows are stored as `<parent>-1`, `<parent>-2`, ...)
  const ooeFirst = await client.query(`
    UPDATE training_fund_transaction t
    SET booking_id = b.id::text
    FROM booking b
    WHERE t.type = 'booking_usage'
      AND t.booking_id IS NULL
      AND (t.tenant_id IS NULL OR b.tenant_id IS NULL OR b.tenant_id = t.tenant_id)
      AND b.booking_reference = SUBSTRING(t.reason FROM '\\((OOE-[A-Za-z0-9]+-[A-Za-z0-9]+)\\)\\s*$') || '-1'
    RETURNING t.id, t.amount, b.booking_reference
  `);
  console.log(`\nLinked ${ooeFirst.rowCount} multi-attendee (OOE-...-1) transaction(s):`);
  for (const r of ooeFirst.rows) {
    console.log(`  tx ${r.id} -> ${r.booking_reference} (£${r.amount})`);
  }

  const cebResult = await client.query(`
    UPDATE training_fund_transaction t
    SET booking_id = ceb.id::text
    FROM complex_event_booking ceb
    WHERE t.type = 'booking_usage'
      AND t.booking_id IS NULL
      AND (t.tenant_id IS NULL OR ceb.tenant_id IS NULL OR ceb.tenant_id = t.tenant_id)
      AND ceb.booking_reference = SUBSTRING(t.reason FROM '\\((CEB-[A-Za-z0-9-]+)\\)\\s*$')
    RETURNING t.id, t.amount, ceb.booking_reference
  `);
  console.log(`\nLinked ${cebResult.rowCount} complex (CEB-) booking transaction(s):`);
  for (const r of cebResult.rows) {
    console.log(`  tx ${r.id} -> ${r.booking_reference} (£${r.amount})`);
  }

  const after = await client.query(`
    SELECT COUNT(*)::int AS c
    FROM training_fund_transaction
    WHERE type = 'booking_usage' AND booking_id IS NULL
  `);
  console.log(`\nBooking-usage transactions missing booking_id (after):  ${after.rows[0].c}`);

  await client.end();
  console.log('\nDone');
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
