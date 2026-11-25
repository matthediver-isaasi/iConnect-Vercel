import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

// Minimal stand-ins for the funnel/membership tables the migration touches.
// The journey-decision patch runs against the real published function text.
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = uuid(1), OTHER_T = uuid(2), ORG = uuid(3), BUYER = uuid(4), ATTENDEE = uuid(5), STRANGER = uuid(6);
const ORG_TIER = uuid(10), MEMBER_TIER = uuid(11), VERSION = uuid(12), DEFINITION = uuid(13), SESSION = uuid(14);
const B1 = uuid(20), B2 = uuid(21), B3 = uuid(22);

test('event funnel complimentary membership: grant, consume once, withdraw unused, immutable evidence', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('funnel-membership-');
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
  const migration = name => readFile(new URL(`./${name}`, import.meta.url), 'utf8');
  let started = false, db;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid NOT NULL);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,email text,organization_id uuid);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,name text,structure_scope_type text,is_active boolean DEFAULT true);
      CREATE TABLE organisation_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,organization_id uuid,
        config_id uuid,membership_year text,annual_cost numeric,final_cost numeric,vat_amount numeric,total_with_vat numeric,currency text,
        payment_status text,payment_method text,paid_at timestamptz,stripe_payment_intent_id text,billing_agreement_id uuid,
        proposal_membership jsonb,membership_payment_quote_id uuid);
      CREATE TABLE member_membership_history(LIKE organisation_membership_history INCLUDING DEFAULTS);
      ALTER TABLE member_membership_history DROP COLUMN organization_id, ADD COLUMN member_id uuid;
      CREATE TABLE event_funnel_definition(id uuid PRIMARY KEY,tenant_id uuid,name text);
      CREATE TABLE event_funnel_version(id uuid PRIMARY KEY,tenant_id uuid,definition_id uuid,graph jsonb,UNIQUE(tenant_id,id));
      CREATE TABLE event_funnel_session(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,journey jsonb,UNIQUE(tenant_id,id));
      CREATE TABLE event_funnel_order(id uuid PRIMARY KEY,tenant_id uuid,session_id uuid,version_id uuid,state text,
        snapshot jsonb,created_at timestamptz DEFAULT now(),UNIQUE(tenant_id,id));
      CREATE TABLE event_funnel_order_booking(tenant_id uuid,order_id uuid,booking_id uuid,node_id text);
      CREATE TABLE event_funnel_reversal(id uuid PRIMARY KEY,tenant_id uuid,order_id uuid,state text DEFAULT 'reserved',
        allocations jsonb,cancelled_at timestamptz);
      CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,quote jsonb);
      CREATE TABLE form_submission(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,payment_meta jsonb);
      CREATE TABLE membership_fee_token(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,cost_breakdown jsonb);
      CREATE TABLE member_membership_start(id uuid PRIMARY KEY);
    `);
    // Real member Start function text (bodies compile lazily); the migration patches it.
    const startSql = await migration('202612310022_member_membership_start.sql');
    const startAt = startSql.indexOf('CREATE FUNCTION public.create_member_start(');
    await db.query('SET check_function_bodies=off');
    await db.query(startSql.slice(startAt, startSql.indexOf('END $$;', startAt) + 7));
    await db.query('RESET check_function_bodies');
    // Real journey function from its only definition; the DO block patches it.
    const journeySql = await migration('202701230004_event_funnel_journey.sql');
    const start = journeySql.indexOf('CREATE FUNCTION public.event_funnel_apply_journey(');
    const journeyFn = journeySql.slice(start, journeySql.indexOf('END $$;', start) + 7);
    assert.equal(journeyFn.split(`node->>'type' NOT IN ('event','addon') OR decision.value IS DISTINCT FROM '"skip"'::jsonb`).length, 2);
    await db.query(journeyFn);
    await db.query(await migration('202701270001_event_funnel_membership_entitlements.sql'));
    const patched = (await db.query(`SELECT pg_get_functiondef('public.event_funnel_apply_journey'::regproc) d`)).rows[0].d;
    assert.match(patched, /node->>'type'\)='membership'|node->>'type'='membership'/);
    assert.match(patched, /"accept"/);
    const startPatched = (await db.query(`SELECT pg_get_functiondef('public.create_member_start'::regproc) d`)).rows[0].d;
    assert.match(startPatched, /INSERT INTO member_membership_history \(tenant_id,member_id,funnel_membership,/);
    assert.match(startPatched, /VALUES \(p_tenant_id,p_member_id,nullif\(p_quote->'funnelMembership','null'::jsonb\),/);

    await db.query(`INSERT INTO organization VALUES($1,$2),($3,$4)`, [ORG, T, uuid(7), OTHER_T]);
    await db.query(`INSERT INTO member VALUES($1,$2,'buyer@example.test',$3),($4,$2,'Attendee@Example.test',NULL),($5,$2,'x@example.test',NULL)`,
      [BUYER, T, ORG, ATTENDEE, STRANGER]);
    await db.query(`INSERT INTO membership_tier_config VALUES($1,$3,'Corporate','organization',true),($2,$3,'Individual','member',true)`,
      [ORG_TIER, MEMBER_TIER, T]);
    const graph = { entry: 'source', nodes: [
      { id: 'source', type: 'source', requires: [] },
      { id: 'org', type: 'membership', requires: [], membership: { scheduleId: ORG_TIER, scope: 'organization', recipientMode: 'purchaser' } },
      { id: 'ind', type: 'membership', requires: ['source'], membership: { scheduleId: MEMBER_TIER, scope: 'member', recipientMode: 'attendees' } },
    ] };
    await db.query(`INSERT INTO event_funnel_definition VALUES($1,$2,'Spring conference')`, [DEFINITION, T]);
    await db.query(`INSERT INTO event_funnel_version VALUES($1,$2,$3,$4)`, [VERSION, T, DEFINITION, graph]);
    await db.query(`INSERT INTO event_funnel_session VALUES($1,$2,$3,$4)`, [SESSION, T, BUYER,
      { decisions: { org: 'accept', ind: 'accept' } }]);

    const memberships = overrides => [
      { nodeId: 'org', scheduleId: ORG_TIER, scope: 'organization', recipientMode: 'purchaser', qualifyingNodeIds: ['source'],
        recipients: [{ kind: 'organization', id: ORG, bookingIds: [B1, B2] }] },
      { nodeId: 'ind', scheduleId: MEMBER_TIER, scope: 'member', recipientMode: 'attendees', qualifyingNodeIds: ['source'],
        recipients: [{ kind: 'member', id: ATTENDEE, bookingIds: [B2] }] },
      ...(overrides || []),
    ];
    const snapshot = list => ({ memberships: list, lines: [{ nodeId: 'source', registrations: [
      { id: B1, row: { attendee_email: 'buyer@example.test' } }, { id: B2, row: { attendee_email: ' attendee@example.test ' } }] }] });
    let orderN = 30;
    const order = async (list, confirm = true) => {
      const id = uuid(orderN++);
      await db.query(`INSERT INTO event_funnel_order VALUES($1,$2,$3,$4,'confirming',$5)`, [id, T, SESSION, VERSION, snapshot(list)]);
      await db.query(`INSERT INTO event_funnel_order_booking VALUES($1,$2,$3,'source'),($1,$2,$4,'source')`, [T, id, B1, B2]);
      if (confirm) await db.query(`UPDATE event_funnel_order SET state='confirmed' WHERE id=$1`, [id]);
      return id;
    };
    const rejectsOrder = async (list, code) => {
      const id = await order(list, false);
      await assert.rejects(db.query(`UPDATE event_funnel_order SET state='confirmed' WHERE id=$1`, [id]), { code });
    };

    // Forged or mismatched evidence is rejected inside the confirmation.
    await rejectsOrder([{ ...memberships()[0], scheduleId: MEMBER_TIER }], '22023');
    await rejectsOrder([{ ...memberships()[0], recipients: [{ kind: 'organization', id: uuid(7), bookingIds: [B1] }] }], 'PT409');
    await rejectsOrder([{ ...memberships()[1], recipients: [{ kind: 'member', id: STRANGER, bookingIds: [B2] }] }], 'PT409');
    await rejectsOrder([{ ...memberships()[1], recipients: [{ kind: 'member', id: ATTENDEE, bookingIds: [B3] }] }], '22023');
    await rejectsOrder([{ ...memberships()[1], qualifyingNodeIds: ['org'] }], '22023');
    await db.query(`UPDATE event_funnel_session SET journey='{"decisions":{"org":"skip","ind":"accept"}}' WHERE id=$1`, [SESSION]);
    await rejectsOrder([memberships()[0]], '22023');
    await db.query(`UPDATE event_funnel_session SET journey='{"decisions":{"org":"accept","ind":"accept"}}' WHERE id=$1`, [SESSION]);
    assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_membership_entitlement')).rows[0].n, 0);

    const first = await order(memberships());
    const pendingOrg = (await db.query(`SELECT pending_event_funnel_membership($1,'organization',$2,$3) e`, [T, ORG, ORG_TIER])).rows[0].e;
    assert.equal(pendingOrg.order_id, first);
    assert.equal(pendingOrg.benefit_snapshot.scheduleName, 'Corporate');
    assert.equal((await db.query(`SELECT pending_event_funnel_membership($1,'organization',$2,$3) e`, [OTHER_T, ORG, ORG_TIER])).rows[0].e, null);
    // Re-confirming the same order is idempotent.
    await db.query(`UPDATE event_funnel_order SET state='confirming' WHERE id=$1`, [first]);
    await db.query(`UPDATE event_funnel_order SET state='confirmed' WHERE id=$1`, [first]);
    assert.equal((await db.query('SELECT count(*)::int n FROM event_funnel_membership_entitlement')).rows[0].n, 2);

    // Consumption: the next matching period must carry matching evidence.
    const insertOrgHistory = (fields = {}) => db.query(`INSERT INTO organisation_membership_history
      (tenant_id,organization_id,config_id,membership_year,annual_cost,final_cost,vat_amount,total_with_vat,currency,funnel_membership,billing_agreement_id,proposal_membership)
      VALUES($1,$2,$3,'2027',500,$4,0,$4,'GBP',$5,$6,$7) RETURNING *`,
      [T, ORG, ORG_TIER, fields.total ?? 0, fields.funnel === undefined ? null : fields.funnel, fields.agreement || null, fields.proposal || null]);
    const evidence = { entitlementId: pendingOrg.id, scheduleId: ORG_TIER, orderId: first, originalBaseNetMinor: 50000, originalBaseVatMinor: 10000 };
    await assert.rejects(insertOrgHistory(), { code: 'PT409' });
    await assert.rejects(insertOrgHistory({ funnel: { ...evidence, entitlementId: uuid(99) } }), { code: 'PT409' });
    await assert.rejects(insertOrgHistory({ funnel: { ...evidence, originalBaseNetMinor: -1 } }), { code: '22023' });
    await assert.rejects(insertOrgHistory({ funnel: evidence, agreement: uuid(98) }), { code: 'PT409' });
    await assert.rejects(insertOrgHistory({ funnel: evidence, proposal: { entitlementId: uuid(97) } }), { code: '22023' });
    const consumed = (await insertOrgHistory({ funnel: evidence })).rows[0];
    assert.equal(consumed.payment_status, 'paid');
    assert.equal(consumed.payment_method, 'event_funnel_entitlement');
    assert.equal(consumed.paid_at, null);
    // Later periods use normal pricing: no pending benefit and no evidence required.
    assert.equal((await db.query(`SELECT pending_event_funnel_membership($1,'organization',$2,$3) e`, [T, ORG, ORG_TIER])).rows[0].e, null);
    await insertOrgHistory({ total: 600 });
    await assert.rejects(insertOrgHistory({ funnel: evidence }), { code: 'PT409' });
    // Complimentary history is not payment evidence and its amounts are fixed.
    await assert.rejects(db.query(`UPDATE organisation_membership_history SET paid_at=now() WHERE id=$1`, [consumed.id]), { code: '23514' });
    await assert.rejects(db.query(`UPDATE organisation_membership_history SET final_cost=500 WHERE id=$1`, [consumed.id]), { code: '23514' });
    await assert.rejects(db.query(`UPDATE organisation_membership_history SET funnel_membership=NULL WHERE id=$1`, [consumed.id]), { code: '23514' });
    await db.query(`UPDATE organisation_membership_history SET payment_status='paid' WHERE id=$1`, [consumed.id]);

    // Cancellation: a partial cancellation keeps the benefit; cancelling every
    // qualifying booking withdraws only unused benefits.
    await db.query(`INSERT INTO event_funnel_reversal(id,tenant_id,order_id,allocations) VALUES($1,$2,$3,$4)`,
      [uuid(60), T, first, JSON.stringify([{ source: 'booking', id: B1 }])]);
    await db.query(`UPDATE event_funnel_reversal SET cancelled_at=now() WHERE id=$1`, [uuid(60)]);
    let outcome = (await db.query('SELECT event_funnel_order_membership_outcome($1,$2) o', [T, first])).rows[0].o;
    assert.deepEqual(outcome.map(item => item.state).sort(), ['available', 'consumed']);
    await db.query(`INSERT INTO event_funnel_reversal(id,tenant_id,order_id,allocations) VALUES($1,$2,$3,$4)`,
      [uuid(61), T, first, JSON.stringify([{ source: 'booking', id: B2 }])]);
    await db.query(`UPDATE event_funnel_reversal SET cancelled_at=now() WHERE id=$1`, [uuid(61)]);
    outcome = (await db.query('SELECT event_funnel_order_membership_outcome($1,$2) o', [T, first])).rows[0].o;
    assert.deepEqual(Object.fromEntries(outcome.map(item => [item.scheduleName, item.state])), { Corporate: 'consumed', Individual: 'withdrawn' });
    assert.equal((await db.query(`SELECT pending_event_funnel_membership($1,'member',$2,$3) e`, [T, ATTENDEE, MEMBER_TIER])).rows[0].e, null);
    await assert.rejects(db.query(`INSERT INTO member_membership_history(tenant_id,member_id,config_id,membership_year,final_cost,total_with_vat,funnel_membership)
      VALUES($1,$2,$3,'2027',0,0,$4)`, [T, ATTENDEE, MEMBER_TIER, { entitlementId: outcome[1].id, scheduleId: MEMBER_TIER, orderId: first,
      originalBaseNetMinor: 1, originalBaseVatMinor: 0 }]), { code: 'PT409' });
    await assert.rejects(db.query('DELETE FROM event_funnel_membership_entitlement'), { code: '23514' });
    await assert.rejects(db.query('UPDATE event_funnel_membership_consumption SET original_base_net_minor=0'), { code: '23514' });

    // Individual benefit consumed on the member's next period.
    const second = await order([memberships()[1]]);
    const pendingMember = (await db.query(`SELECT pending_event_funnel_membership($1,'member',$2,$3) e`, [T, ATTENDEE, MEMBER_TIER])).rows[0].e;
    assert.equal(pendingMember.order_id, second);
    const memberRow = (await db.query(`INSERT INTO member_membership_history(tenant_id,member_id,config_id,membership_year,final_cost,total_with_vat,funnel_membership)
      VALUES($1,$2,$3,'2027',25,25,$4) RETURNING *`, [T, ATTENDEE, MEMBER_TIER, { entitlementId: pendingMember.id, scheduleId: MEMBER_TIER,
      orderId: second, originalBaseNetMinor: 4000, originalBaseVatMinor: 800 }])).rows[0];
    // Add-ons remain payable: a non-zero remainder keeps its normal payment state.
    assert.equal(memberRow.payment_method, null);
    const listed = (await db.query(`SELECT list_event_funnel_memberships($1,'member',$2) l`, [T, ATTENDEE])).rows[0].l;
    assert.deepEqual(listed.map(item => item.state), ['withdrawn', 'consumed']);
    assert.equal(listed[1].consumption.originalBaseNetMinor, 4000);
    assert.equal(listed[1].source.funnelName, 'Spring conference');

    // Reservations: a checkout charging add-ons holds the benefit before any
    // provider payment; another checkout cannot consume it and cancellation
    // does not withdraw it underneath the payment.
    const third = await order([memberships()[0]]);
    const pendingThird = (await db.query(`SELECT pending_event_funnel_membership($1,'organization',$2,$3) e`, [T, ORG, ORG_TIER])).rows[0].e;
    const benefit = { entitlementId: pendingThird.id, scheduleId: ORG_TIER, scope: 'organization', orderId: third,
      originalBaseNetMinor: 50000, originalBaseVatMinor: 10000 };
    const saveQuote = sim => db.query(`INSERT INTO membership_payment_quote(tenant_id,member_id,organization_id,quote) VALUES($1,$2,$3,$4) RETURNING id`,
      [T, BUYER, ORG, { simResult: { config: { id: ORG_TIER }, funnelMembership: sim } }]);
    await assert.rejects(saveQuote({ ...benefit, scheduleId: MEMBER_TIER }), { code: '22023' });
    const quoteId = (await saveQuote(benefit)).rows[0].id;
    await assert.rejects(saveQuote(benefit), { code: 'PT409' });
    await assert.rejects(db.query(`INSERT INTO form_submission(tenant_id,member_id,payment_meta) VALUES($1,$2,$3)`,
      [T, BUYER, { prefill_organization_id: ORG, membership: { quote: { config_id: ORG_TIER, funnel_membership: benefit } } }]), { code: 'PT409' });
    const token = (await db.query(`INSERT INTO membership_fee_token(tenant_id,organization_id,cost_breakdown) VALUES($1,$2,$3) RETURNING id`,
      [T, ORG, { funnelMembership: benefit }])).rows[0].id;
    await assert.rejects(db.query('SELECT reserve_event_funnel_membership_fee_token($1,$2)', [T, token]), { code: 'PT409' });
    for (const [id, booking] of [[uuid(62), B1], [uuid(63), B2]]) {
      await db.query(`INSERT INTO event_funnel_reversal(id,tenant_id,order_id,allocations) VALUES($1,$2,$3,$4)`,
        [id, T, third, JSON.stringify([{ source: 'booking', id: booking }])]);
      await db.query(`UPDATE event_funnel_reversal SET cancelled_at=now() WHERE id=$1`, [id]);
    }
    assert.deepEqual((await db.query('SELECT event_funnel_order_membership_outcome($1,$2) o', [T, third])).rows[0].o.map(i => i.state), ['reserved']);
    await assert.rejects(insertOrgHistory({ funnel: benefit, total: 36 }), { code: 'PT409' });
    const reservedRow = (await db.query(`INSERT INTO organisation_membership_history
      (tenant_id,organization_id,config_id,membership_year,final_cost,total_with_vat,funnel_membership,membership_payment_quote_id)
      VALUES($1,$2,$3,'2028',30,36,$4,$5) RETURNING *`, [T, ORG, ORG_TIER, benefit, quoteId])).rows[0];
    assert.equal(reservedRow.payment_method, null, 'add-on payment keeps its normal payment state');
    await assert.rejects(db.query('DELETE FROM event_funnel_membership_reservation'), { code: '23514' });

    // Fee-link reservation is idempotent for its own token and owns consumption.
    const fourth = await order([memberships()[0]]);
    const pendingFourth = (await db.query(`SELECT pending_event_funnel_membership($1,'organization',$2,$3) e`, [T, ORG, ORG_TIER])).rows[0].e;
    const linkBenefit = { ...benefit, entitlementId: pendingFourth.id, orderId: fourth };
    const linkToken = (await db.query(`INSERT INTO membership_fee_token(tenant_id,organization_id,cost_breakdown) VALUES($1,$2,$3) RETURNING id`,
      [T, ORG, { funnelMembership: linkBenefit }])).rows[0].id;
    for (let i = 0; i < 2; i++) assert.equal((await db.query('SELECT reserve_event_funnel_membership_fee_token($1,$2) r', [T, linkToken])).rows[0].r, true);
    await assert.rejects(insertOrgHistory({ funnel: { ...linkBenefit, feeTokenId: uuid(96) }, total: 36 }), { code: 'PT409' });
    await insertOrgHistory({ funnel: { ...linkBenefit, feeTokenId: linkToken }, total: 36 });
    assert.equal((await db.query('SELECT reserve_event_funnel_membership_fee_token($1,$2) r', [T, linkToken])).rows[0].r, true);

    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query(`SELECT list_event_funnel_memberships($1,'member',$2)`, [T, ATTENDEE]), { code: '42501' });
      await assert.rejects(db.query('SELECT * FROM event_funnel_membership_entitlement'), { code: '42501' });
      await db.query('RESET ROLE');
    }
  } finally {
    await db?.end().catch(() => {});
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop']);
    await h.cleanup?.();
  }
});
