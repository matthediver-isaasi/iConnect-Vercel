import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';
import { freezeMembershipBenefit } from '../../shared/proposalMembershipEntitlements.js';
import pg from 'pg';

test('proposal membership grants are atomic, tenant scoped and immutable', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('proposal-membership-');
  let started = false;
  const run = (command, args, input, failure = false) => {
    const result = spawnSync(command, args, { input, encoding: 'utf8' });
    if (failure) assert.notEqual(result.status, 0, result.stdout);
    else assert.equal(result.status, 0, result.stderr);
    return failure ? result.stderr : result.stdout.trim();
  };
  const sql = (input, failure = false) => run('psql',
    ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'],
    input, failure);
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tenant = id(1), foreignTenant = id(2), organisation = id(3), schedule = id(4);
  const benefit = freezeMembershipBenefit({
    id: schedule, tenant_id: tenant, name: 'Annual organisation', structure_scope_type: 'organization', is_active: true,
  }, tenant);
  const json = value => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const create = (n, { bundle = false, quantity = 1, componentQuantity = 1, snapshot = benefit, org = organisation, tenantId = tenant } = {}) => {
    sql(`
      INSERT INTO sales_quote VALUES('${id(n)}','${tenantId}');
      INSERT INTO sales_quote_version VALUES('${id(n + 1)}','${tenantId}','${id(n)}','sent',${json({ id: org })});
      INSERT INTO sales_quote_line VALUES('${id(n + 2)}','${tenantId}','${id(n + 1)}',
        '${bundle ? 'bundle' : 'product'}',${quantity},${json(bundle ? {} : { membershipBenefit: snapshot })});
      ${bundle ? `INSERT INTO sales_quote_bundle_component VALUES('${id(n + 3)}','${tenantId}','${id(n + 2)}',${componentQuantity},${json({ membershipBenefit: snapshot })});` : ''}
    `);
    return id(n + 1);
  };
  const accept = version => `UPDATE sales_quote_version SET status='accepted' WHERE id='${version}';`;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,structure_scope_type text,is_active boolean);
      CREATE TABLE sales_quote(id uuid PRIMARY KEY,tenant_id uuid,UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_version(id uuid PRIMARY KEY,tenant_id uuid,quote_id uuid,status text,organisation_snapshot jsonb,UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_line(id uuid PRIMARY KEY,tenant_id uuid,quote_version_id uuid,catalogue_kind text,quantity numeric,catalogue_snapshot jsonb,UNIQUE(tenant_id,id));
      CREATE TABLE sales_quote_bundle_component(id uuid PRIMARY KEY,tenant_id uuid,quote_line_id uuid,quantity numeric,product_snapshot jsonb);
      INSERT INTO tenant VALUES('${tenant}'),('${foreignTenant}');
      INSERT INTO organization VALUES('${organisation}','${tenant}');
      INSERT INTO membership_tier_config VALUES('${schedule}','${tenant}','organization',true);
    `);
    sql(readFileSync(new URL('./202701240001_proposal_membership_entitlement_contract.sql', import.meta.url), 'utf8'));
    const direct = create(10);
    sql(accept(direct));
    sql(accept(direct));
    assert.equal(sql('SELECT count(*) FROM proposal_membership_entitlement'), '1');
    const bundled = create(20, { bundle: true });
    sql(accept(bundled));
    assert.equal(sql(`SELECT component_id FROM proposal_membership_entitlement WHERE quote_version_id='${bundled}'`), id(23));
    assert.equal(sql(`SELECT organization_id FROM proposal_membership_entitlement WHERE quote_version_id='${direct}'`), organisation);

    // A failure anywhere in acceptance rolls the grant and status back.
    const rollback = create(30);
    sql(`BEGIN; ${accept(rollback)} ROLLBACK;`);
    assert.equal(sql(`SELECT count(*) FROM proposal_membership_entitlement WHERE quote_version_id='${rollback}'`), '0');
    assert.equal(sql(`SELECT status FROM sales_quote_version WHERE id='${rollback}'`), 'sent');
    sql(accept(rollback));

    for (const [n, options, message] of [
      [40, { quantity: 2 }, /quantities must be 1/],
      [50, { bundle: true, quantity: 0.5, componentQuantity: 2 }, /quantities must be 1/],
      [60, { snapshot: { ...benefit, periods: 2 } }, /benefit is invalid/],
      [70, { org: id(999) }, /organisation is unavailable/],
      [80, { tenantId: foreignTenant }, /organisation is unavailable/],
      [90, { snapshot: { ...benefit, scheduleId: id(999) } }, /schedule is unavailable/],
    ]) {
      const version = create(n, options);
      assert.match(sql(accept(version), true), message);
      assert.equal(sql(`SELECT status FROM sales_quote_version WHERE id='${version}'`), 'sent');
      assert.equal(sql(`SELECT count(*) FROM proposal_membership_entitlement WHERE quote_version_id='${version}'`), '0');
    }
    const duplicate = create(100);
    sql(`INSERT INTO sales_quote_line VALUES('${id(105)}','${tenant}','${duplicate}','product',1,${json({ membershipBenefit: benefit })})`);
    assert.match(sql(accept(duplicate), true), /at most one membership benefit/);
    assert.equal(sql(`SELECT count(*) FROM proposal_membership_entitlement WHERE quote_version_id='${duplicate}'`), '0');

    sql(`UPDATE membership_tier_config SET is_active=false WHERE id='${schedule}'`);
    const inactive = create(110);
    assert.match(sql(accept(inactive), true), /schedule is unavailable/);
    // Previously accepted benefits retain their immutable meaning.
    assert.equal(sql(`SELECT benefit_snapshot->>'scheduleName' FROM proposal_membership_entitlement WHERE quote_version_id='${direct}'`), benefit.scheduleName);
    assert.match(sql('UPDATE proposal_membership_entitlement SET granted_at=now()', true), /immutable/);
    assert.match(sql('DELETE FROM proposal_membership_entitlement', true), /immutable/);
    for (const role of ['anon', 'authenticated']) {
      assert.match(sql(`SET ROLE ${role}; SELECT * FROM proposal_membership_entitlement`, true), /permission denied/);
    }
    assert.equal(sql(`SET ROLE service_role; SELECT count(*) FROM proposal_membership_entitlement`).split('\n').at(-1), '3');
    assert.match(sql('SET ROLE service_role; DELETE FROM proposal_membership_entitlement', true), /permission denied/);
    assert.equal(sql(`SELECT has_function_privilege('service_role','grant_accepted_proposal_memberships()','EXECUTE')`), 'f');
    sql(`
      CREATE TABLE organisation_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid,organization_id uuid,config_id uuid,membership_year text,
        final_cost numeric,total_with_vat numeric,currency text,vat_amount numeric,annual_cost numeric,payment_status text,payment_method text,paid_at timestamptz,
        billing_agreement_id uuid,stripe_payment_intent_id text,membership_payment_quote_id uuid,
        UNIQUE(tenant_id,organization_id,membership_year));
      CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid,member_id uuid,organization_id uuid,quote jsonb);
      CREATE FUNCTION reserve_form_membership_payment_quote(p_tenant_id uuid,p_member_id uuid,p_organization_id uuid,p_quote jsonb)
      RETURNS jsonb LANGUAGE plpgsql AS $fn$
      DECLARE q membership_payment_quote%ROWTYPE;
      BEGIN
        INSERT INTO membership_payment_quote(tenant_id,member_id,organization_id,quote)
          VALUES(p_tenant_id,p_member_id,p_organization_id,p_quote) RETURNING * INTO q;
        RETURN to_jsonb(q);
      END $fn$;
    `);
    sql(readFileSync(new URL('./202701240003_proposal_membership_consumption.sql', import.meta.url), 'utf8'));
    sql(readFileSync(new URL('./202701240004_proposal_membership_payment_reservations.sql', import.meta.url), 'utf8'));
    sql(`CREATE TABLE form_submission(id uuid PRIMARY KEY,tenant_id uuid,payment_meta jsonb);`);
    sql(readFileSync(new URL('./202701240005_proposal_membership_form_reservations.sql', import.meta.url), 'utf8'));
    sql(`CREATE TABLE membership_fee_token(id uuid PRIMARY KEY,tenant_id uuid,organization_id uuid,cost_breakdown jsonb);`);
    sql(readFileSync(new URL('./202701240006_proposal_membership_fee_token_reservations.sql', import.meta.url), 'utf8'));
    const pending = () => JSON.parse(sql(`SELECT pending_proposal_membership_entitlement('${tenant}','${organisation}','${schedule}')`));
    const first = pending();
    const marker = e => ({
      entitlementId: e.id, scheduleId: schedule, quoteId: e.quote_id, quoteVersionId: e.quote_version_id,
      originalBaseNetMinor: 10000, originalBaseVatMinor: 2000,
    });
    const history = (year, e, quoteId = null) => `INSERT INTO organisation_membership_history(
      tenant_id,organization_id,config_id,membership_year,final_cost,total_with_vat,proposal_membership,membership_payment_quote_id)
      VALUES('${tenant}','${organisation}','${schedule}','${year}',0,0,${e ? json(marker(e)) : 'NULL'},${quoteId ? `'${quoteId}'` : 'NULL'});`;
    assert.match(sql(history('2027', null), true), /must be recalculated/);
    sql(`BEGIN; ${history('2027', first)} ROLLBACK;`);
    assert.equal(pending().id, first.id, 'rolled-back creation retains the benefit');
    sql(history('2027', first));
    assert.equal(sql(`SELECT payment_method||':'||(paid_at IS NULL) FROM organisation_membership_history WHERE membership_year='2027'`), 'proposal_entitlement:true');
    assert.match(sql(history('2028', first), true), /recalculated/);
    assert.match(sql(`UPDATE organisation_membership_history SET final_cost=100`, true), /immutable/);
    const second = pending();
    assert.match(sql(history('2027', second), true), /duplicate key/);
    assert.equal(pending().id, second.id, 'failed history insertion does not consume the next grant');
    const quote = {
      simResult: {
        config: { id: schedule }, membershipYear: { label: '2028' },
        proposalMembership: marker(second), finalCost: 0, totalWithVat: 0,
      },
    };
    const reserve = `SELECT reserve_form_membership_payment_quote('${tenant}','${id(200)}','${organisation}',${json(quote)})`;
    const reserved = JSON.parse(sql(reserve));
    assert.equal(JSON.parse(sql(reserve)).id, reserved.id, 'retry reuses the same payment reservation');
    assert.match(sql(history('2028', second), true), /reserved by a payment checkout/);
    sql(history('2028', second, reserved.id));
    const third = pending();
    const submission = id(250);
    const formMeta = { prefill_organization_id: organisation, membership: { quote: {
      config_id: schedule, proposal_membership: marker(third),
    } } };
    sql(`INSERT INTO form_submission VALUES('${submission}','${tenant}',${json(formMeta)})`);
    assert.match(sql(history('2029', third), true), /reserved by a payment checkout/);
    sql(history('2029', third).replace(json(marker(third)), json({ ...marker(third), submissionId: submission })));
    assert.equal(sql(`SELECT pending_proposal_membership_entitlement('${tenant}','${organisation}','${schedule}')`), '');
    sql(history('2030', null));
    assert.equal(sql('SELECT count(*) FROM proposal_membership_consumption'), '3');
    sql(`UPDATE membership_tier_config SET is_active=true WHERE id='${schedule}'`);
    sql(accept(create(400)));
    const concurrent = pending();
    const clients = [0, 1].map(() => new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' }));
    try {
      await Promise.all(clients.map(client => client.connect()));
      const outcomes = await Promise.allSettled(clients.map((client, index) => client.query(history(`203${index + 1}`, concurrent))));
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
      assert.equal(sql(`SELECT count(*) FROM proposal_membership_consumption WHERE entitlement_id='${concurrent.id}'`), '1');
    } finally { await Promise.all(clients.map(client => client.end())); }
    sql(accept(create(500)));
    const emailGrant = pending(), tokenId = id(550);
    sql(`INSERT INTO membership_fee_token VALUES('${tokenId}','${tenant}','${organisation}',${json({ proposalMembership: marker(emailGrant) })})`);
    const reserveFee = `SELECT reserve_proposal_membership_fee_token('${tenant}','${tokenId}')`;
    assert.equal(sql(reserveFee), 't');
    assert.equal(sql(reserveFee), 't');
    assert.match(sql(history('2035', emailGrant), true), /reserved by a payment checkout/);
    sql(history('2035', emailGrant).replace(json(marker(emailGrant)), json({ ...marker(emailGrant), feeTokenId: tokenId })));
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
