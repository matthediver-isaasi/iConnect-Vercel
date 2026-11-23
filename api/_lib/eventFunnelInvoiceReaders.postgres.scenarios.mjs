import assert from 'node:assert/strict';
export async function exerciseFunnelInvoiceReaders({db,sql}) {
  // Earlier inventory fixtures intentionally omit presentation-only columns.
  // Add the real booking reference column for the report/download scenario.
  for(const table of ['booking','complex_event_booking']) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS booking_group_reference text`);
    await db.query(`UPDATE ${table} r SET booking_group_reference='fixture-'||b.order_id::text||'-'||b.event_id::text
      FROM event_funnel_order_booking b WHERE b.tenant_id=r.tenant_id AND b.booking_id=r.id AND b.booking_source=$1`,[table]);
  }
  await db.query(await sql('202701230018_event_funnel_invoice_readers.sql'));
  const records=(await db.query(`SELECT b.*,w.invoice_id,s.member_id,o.snapshot->>'invoiceMode' invoice_mode,
    CASE WHEN b.booking_source='booking' THEN (SELECT booking_group_reference FROM booking WHERE id=b.booking_id)
      ELSE (SELECT booking_group_reference FROM complex_event_booking WHERE id=b.booking_id) END group_ref
    FROM event_funnel_invoice_booking l JOIN event_funnel_order_booking b
      USING(tenant_id,booking_source,booking_id) JOIN event_funnel_invoice_work w ON w.id=l.invoice_work_id
    JOIN event_funnel_order o ON o.tenant_id=b.tenant_id AND o.id=b.order_id
    JOIN event_funnel_session s ON s.tenant_id=o.tenant_id AND s.id=o.session_id
    WHERE w.status='complete'`)).rows;
  assert.ok(records.length);
  const r=records[0],input=records.map(b=>({source:b.booking_source,id:b.booking_id}));
  await db.query('SET ROLE service_role');
  const report=(await db.query('SELECT event_funnel_invoice_report($1,$2) r',[r.tenant_id,JSON.stringify(input)])).rows[0].r;
  assert.equal(report.length,records.length);
  assert.equal(report[0].invoiceId,r.invoice_id);
  assert.equal(report[0].orderId,r.order_id);
  assert.equal(report[0].invoiceMode,r.invoice_mode);
  assert.equal(JSON.stringify(report).includes('snapshot'),false);
  const foreign='00000000-0000-4000-8000-000000000099';
  assert.deepEqual((await db.query('SELECT event_funnel_invoice_report($1,$2) r',[foreign,JSON.stringify(input)])).rows[0].r,[]);
  const download=async(member,admin,tenant=r.tenant_id)=>(await db.query(
    'SELECT event_funnel_invoice_download($1,$2,$3,$4) r',[tenant,r.group_ref,member,admin])).rows[0].r;
  const admin=await download(null,true);assert.equal(admin.invoiceId,r.invoice_id);
  assert.ok(admin.companyId);assert.ok(admin.connectionId);
  if(r.member_id) assert.equal((await download(r.member_id,false)).invoiceId,r.invoice_id);
  await assert.rejects(download(foreign,false),{code:'PT403'});
  await assert.rejects(download(null,false),{code:'PT403'});
  assert.equal(await download(r.member_id,true,foreign),null);
  for(const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(download(null,true),{code:'42501'});
  }
  await db.query('RESET ROLE');
}
