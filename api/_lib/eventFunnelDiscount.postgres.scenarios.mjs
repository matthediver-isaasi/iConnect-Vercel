import assert from 'node:assert/strict';

// Runs last: the replacement prepare function references discount tables.
export async function exerciseFunnelDiscount({ db, uuid, tenant, member, sql }) {
  await db.query(`ALTER TABLE member ADD COLUMN IF NOT EXISTS organization_id uuid, ADD COLUMN IF NOT EXISTS role_id uuid;
    CREATE TABLE IF NOT EXISTS discount_code(id uuid PRIMARY KEY,tenant_id uuid,code text,is_active boolean,expires_at timestamptz,
      event_id uuid,ticket_class_id uuid,type text,value numeric,max_usage_count numeric,current_usage_count numeric,
      organization_id uuid,member_id uuid,role_id uuid,member_group_id uuid);
    CREATE TABLE IF NOT EXISTS discount_code_usage(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,discount_code_id uuid,
      organization_id uuid,member_id uuid,usage_count integer);
    CREATE TABLE IF NOT EXISTS member_group_assignment(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id uuid,group_id uuid);`);
  await db.query(await sql('202711270003_event_funnel_discount_codes.sql'));
  assert.equal((await db.query('SELECT event_funnel_discount_ready() r')).rows[0].r, true);
  const organization = uuid(900), code = uuid(901), other = uuid(902), session = uuid(903);
  await db.query('UPDATE member SET organization_id=$1 WHERE id=$2', [organization, member]);
  const version = (await db.query('SELECT version_id FROM event_funnel_entry WHERE tenant_id=$1', [tenant])).rows[0].version_id;
  const graph = (await db.query('SELECT graph FROM event_funnel_version WHERE id=$1', [version])).rows[0].graph;
  const eventId = graph.nodes.find(node => node.id === graph.entry).event.id;
  await db.query(`INSERT INTO discount_code VALUES($1,$2,'SPRING',true,NULL,$3,NULL,'percentage',10,5,0,NULL,NULL,NULL,NULL),
    ($4,$2,'ELSEWHERE',true,NULL,$5,NULL,'percentage',10,NULL,0,NULL,NULL,NULL,NULL)`,
  [code, tenant, eventId, other, uuid(999)]);
  await db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)', [tenant, session, version, member]);
  const purchaser = { first_name: 'Discount', last_name: 'Buyer', email: 'discount@example.test', organization: '' };
  const price = { version: 1, unitMinor: 1000, unitAmount: 10, currency: 'GBP', purchaser, paymentMethods: ['card', 'account'] };
  await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,'{"version":1,"decisions":{},"checkoutNow":true}')`,
    [tenant, session, member, JSON.stringify([{ nodeId: graph.entry, ticketId: 'A', quantity: 1, priceSnapshot: price }])]);
  const discount = { discountCodeId: code, code: 'SPRING', type: 'percentage', value: 10, discountMinor: 100,
    lines: [{ nodeId: graph.entry, ticketId: 'A', discountMinor: 100 }] };
  const terms = { version: 1, submissionAccepted: true, invoiceMode: graph.invoiceMode, currency: 'GBP',
    paymentMethod: 'card', payableMinor: 900, discountMinor: 100, discounts: [discount], purchaser,
    lines: [{ nodeId: graph.entry, ticketId: 'A', quantity: 1, places: 1, listMinor: 1000, discountMinor: 100,
      amountMinor: 900, priceSnapshot: price }] };
  const prepare = value => db.query('SELECT event_funnel_prepare_order($1,$2,$3,NULL,2,$4) r', [tenant, session, member, value]);
  // A code for another event, an inflated saving, or a hidden second code fails.
  await assert.rejects(prepare({ ...terms, discounts: [{ ...discount, discountCodeId: other, code: 'ELSEWHERE' }] }), { code: 'PT409' });
  await assert.rejects(prepare({ ...terms, discounts: [discount, discount] }), { code: '22023' });
  await assert.rejects(prepare({ ...terms, discountMinor: 0, discounts: [] }), { code: '22023' });
  await assert.rejects(prepare({ ...terms, lines: [{ ...terms.lines[0], listMinor: 1200 }] }), { code: '22023' });
  await db.query('UPDATE discount_code SET current_usage_count=5 WHERE id=$1', [code]);
  await assert.rejects(prepare(terms), { code: 'PT409' });
  await db.query('UPDATE discount_code SET current_usage_count=0 WHERE id=$1', [code]);
  const order = (await prepare(terms)).rows[0].r;
  assert.equal(Number(order.payable_minor), 900);
  // Preparing does not use the code; confirmation counts it exactly once.
  assert.equal(Number((await db.query('SELECT current_usage_count c FROM discount_code WHERE id=$1', [code])).rows[0].c), 0);
  await db.query(`UPDATE event_funnel_order SET state='confirmed' WHERE id=$1`, [order.id]);
  await db.query(`UPDATE event_funnel_order SET state='confirmed' WHERE id=$1`, [order.id]);
  assert.equal(Number((await db.query('SELECT current_usage_count c FROM discount_code WHERE id=$1', [code])).rows[0].c), 1);
  const usage = (await db.query('SELECT organization_id,member_id,usage_count FROM discount_code_usage WHERE discount_code_id=$1', [code])).rows;
  assert.deepEqual(usage, [{ organization_id: organization, member_id: null, usage_count: 1 }]);
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_discount_redemption WHERE order_id=$1', [order.id])).rows[0].n, 1);
}
