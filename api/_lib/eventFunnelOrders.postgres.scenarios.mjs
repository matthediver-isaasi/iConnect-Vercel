import assert from 'node:assert/strict';
import { funnelPaymentRequest } from './eventFunnelPayment.js';

export async function exerciseFunnelOrders({ db, connect, uuid, tenant, member, sql }) {
  await db.query(await sql('202701230006_event_funnel_payment_orders.sql'));
  const session = uuid(70);
  const version = (await db.query('SELECT version_id FROM event_funnel_entry WHERE tenant_id=$1', [tenant])).rows[0].version_id;
  await db.query('SELECT event_funnel_create_session($1,$2,$3,$4,NULL)', [tenant, session, version, member]);
  const purchaser = { first_name: 'Fixture', last_name: 'Buyer', email: 'fixture@example.test', organization: '' };
  const price = { version: 1, unitMinor: 500, unitAmount: 5, currency: 'GBP', purchaser, paymentMethods: ['card','account'] };
  await db.query(`SELECT event_funnel_apply_journey($1,$2,$3,NULL,1,$4,'{"version":1,"decisions":{},"checkoutNow":true}')`,
    [tenant, session, member, JSON.stringify([{ nodeId: 'source', ticketId: 'A', quantity: 1, priceSnapshot: price }])]);
  const terms = { version: 1, submissionAccepted: true, invoiceMode: 'per_event', currency: 'GBP',
    paymentMethod: 'card', payableMinor: 500, purchaser,
    paymentAuthority: { accountFingerprint: 'fixture-account', mode: 'test' },
    lines: [{ nodeId: 'source', ticketId: 'A', quantity: 1, places: 1, amountMinor: 500, priceSnapshot: price }] };
  const prepare = (client, value = terms) => client.query('SELECT event_funnel_prepare_order($1,$2,$3,NULL,2,$4) r',
    [tenant, session, member, value]);
  await assert.rejects(prepare(db, { ...terms, purchaser: { ...purchaser, email: 'forged@example.test' } }), { code: '22023' });
  await assert.rejects(prepare(db, { ...terms, voucherMinor: 1 }), { code: 'PT409' });
  await assert.rejects(prepare(db, { ...terms, payableMinor: 1 }), { code: '22023' });
  const peer = await connect();
  const concurrent = await Promise.all([prepare(db), prepare(peer)]);
  const order = concurrent[0].rows[0].r;
  assert.equal(order.id, concurrent[1].rows[0].r.id);
  assert.equal((await db.query('SELECT event_funnel_session_order($1,$2,$3,NULL) r',[tenant,session,member])).rows[0].r.id,order.id);
  await assert.rejects(db.query('SELECT event_funnel_session_order($1,$2,$3,NULL)',[tenant,session,uuid(99)]),{code:'PT404'});
  assert.equal((await db.query('SELECT state FROM event_funnel_session WHERE id=$1', [session])).rows[0].state, 'payable');
  await assert.rejects(prepare(db, { ...terms, paymentMethod: 'account' }), { code: 'PT409' });
  await assert.rejects(db.query('UPDATE event_funnel_order SET payable_minor=1 WHERE id=$1', [order.id]), { code: '23514' });
  const parameters = funnelPaymentRequest(order);
  const requested = (await db.query('SELECT event_funnel_payment_request($1,$2,$3) r', [tenant, order.id, parameters])).rows[0].r;
  assert.deepEqual(requested.payment_request, parameters);
  assert.ok(requested.payment_requested_at);
  assert.deepEqual((await db.query('SELECT event_funnel_payment_request($1,$2,$3) r', [tenant, order.id, parameters])).rows[0].r.payment_request, parameters);
  await assert.rejects(db.query('SELECT event_funnel_payment_request($1,$2,$3)', [tenant, order.id, { ...parameters, amount: 1 }]), { code: 'PT409' });
  await assert.rejects(db.query('SELECT event_funnel_payment_request($1,$2,NULL)', [tenant, order.id]), { code: 'PT409' });
  await db.query(`SELECT event_funnel_payment_uncertain($1,$2,'provider_create_unconfirmed')`, [tenant, order.id]);
  assert.equal((await db.query('SELECT state FROM event_funnel_session WHERE id=$1', [session])).rows[0].state, 'payment_uncertain');
  await db.query(`SELECT event_funnel_payment_bind($1,$2,'pi_original')`, [tenant, order.id]);
  await assert.rejects(db.query(`SELECT event_funnel_payment_bind($1,$2,'pi_replacement')`, [tenant, order.id]), { code: 'PT409' });
  await assert.rejects(db.query(`SELECT event_funnel_payment_bind($1,$2,NULL)`, [tenant, order.id]), { code: 'PT409' });
  await assert.rejects(db.query('SELECT event_funnel_owned_order($1,$2,$3,NULL,$4)', [tenant, session, uuid(99), order.id]), { code: 'PT404' });
  for (const role of ['anon','authenticated']) {
    await db.query(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT event_funnel_order_read($1,$2)', [tenant, order.id]), { code: '42501' });
    await assert.rejects(prepare(db), { code: '42501' });
    await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query('SELECT * FROM event_funnel_order'), { code: '42501' });
  assert.equal((await db.query('SELECT event_funnel_owned_order($1,$2,$3,NULL,$4) r', [tenant, session, member, order.id])).rows[0].r.id, order.id);
  await db.query('RESET ROLE');
  await assert.rejects(db.query(`SELECT event_funnel_release_order($1,$2,'{"outcome":"not_started"}')`, [tenant, order.id]), { code: 'PT409' });
  await assert.rejects(db.query(`SELECT event_funnel_release_order($1,$2,'{}')`, [tenant, order.id]), { code: 'PT409' });
  await assert.rejects(db.query(`SELECT event_funnel_release_order($1,$2,'{"outcome":"cancelled","paymentIntentId":"pi_wrong"}')`, [tenant, order.id]), { code: 'PT409' });
  const released = (await db.query(`SELECT event_funnel_release_order($1,$2,'{"outcome":"cancelled","paymentIntentId":"pi_original"}') r`, [tenant, order.id])).rows[0].r;
  assert.equal(released.state, 'cancelled');
  assert.equal((await db.query('SELECT event_funnel_session_order($1,$2,$3,NULL) r',[tenant,session,member])).rows[0].r,null);
  const resumed=(await db.query('SELECT state,expires_at FROM event_funnel_session WHERE id=$1',[session])).rows[0];
  assert.equal(resumed.state,'held');
  assert.equal(resumed.expires_at.toISOString(),new Date(order.snapshot.reservationExpiresAt).toISOString());
  assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_hold WHERE session_id=$1', [session])).rows[0].n, 1);
}
