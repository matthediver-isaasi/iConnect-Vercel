import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

test('isolated PostgreSQL successor claims serialize form versus worker and preserve old obligations', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'successor-election-'));
  const cluster = join(dir, 'data');
  let started = false;
  const clients = [];
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(dir, 'log'), '-o', `-k ${dir} -p 55498 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    for (let n = 0; n < 2; n++) {
      const client = new pg.Client({ host: dir, port: 55498, database: 'postgres', user: 'runner' });
      await client.connect();
      clients.push(client);
    }
    const [a, b] = clients;
    await a.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,membership_paused boolean DEFAULT false);
      CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,membership_paused boolean DEFAULT false);
      CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,term_key text,quote jsonb,stripe_payment_intent_id text);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,organization_id uuid,term_start_date date,status text,metadata jsonb);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,member_id uuid,
        organization_id uuid,term_start_date date,term_end_date date,status text,payment_status text,
        billing_agreement_id uuid,commitment_snapshot jsonb,incentive_snapshot jsonb,term_key text,membership_payment_quote_id uuid);
      CREATE TABLE organisation_membership_history(LIKE member_membership_history INCLUDING ALL);
      INSERT INTO tenant VALUES ('00000000-0000-4000-8000-000000000001');
      INSERT INTO member(id,tenant_id) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
      INSERT INTO member_membership_history(id,tenant_id,member_id,term_start_date,term_end_date,status,payment_status,commitment_snapshot)
        VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',current_date-305,current_date+60,'active','paid',
        '{"config":{"renewal_open_days":60,"renewal_grace_days":7}}');
    `);
    await a.query(await readFile(new URL('../../supabase/migrations/20261201_membership_successor_election.sql', import.meta.url), 'utf8'));
    assert.equal((await a.query('SELECT membership_successor_elections_enabled() enabled')).rows[0].enabled, false);
    await a.query('SET ROLE service_role');
    await assert.rejects(a.query('UPDATE membership_successor_rollout SET enabled=true'), /permission denied/);
    await a.query('RESET ROLE');
    await a.query('UPDATE membership_successor_rollout SET enabled=true');
    const before = (await a.query('SELECT to_jsonb(h) AS row FROM member_membership_history h')).rows[0].row;
    for (const role of ['anon', 'authenticated']) {
      await a.query(`SET ROLE ${role}`);
      await assert.rejects(a.query('SELECT * FROM membership_successor_election'), /permission denied/);
      await assert.rejects(a.query('SELECT membership_successor_elections_enabled()'), /permission denied/);
      await a.query('RESET ROLE');
    }
    const sql = `SELECT reserve_membership_successor(
      '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',NULL,
      '00000000-0000-4000-8000-000000000003',current_date+61,current_date+425,$1,$2,$3::jsonb) AS election`;
    const quote = { payerMemberId: '00000000-0000-4000-8000-000000000002', simulation: { totalWithVat: 120 } };
    await Promise.all(clients.map(client => client.query('SET ROLE service_role')));
    const race = await Promise.allSettled([
      a.query(sql, ['upfront', 'form', JSON.stringify(quote)]),
      b.query(sql, ['direct_debit', 'worker', '{"snapshot":{"monthly_amount":10}}']),
    ]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    const winner = race.find(result => result.status === 'fulfilled').value.rows[0].election;
    const repeated = (await a.query(sql, [winner.payment_method, winner.origin, '{"changed":true}'])).rows[0].election;
    assert.deepEqual(repeated.quote, winner.quote, 'retry never reprices or changes method');
    assert.equal(repeated.id, winner.id);
    await assert.rejects(a.query("UPDATE membership_successor_election SET status='released'"), /permission denied/);
    await a.query('RESET ROLE');
    const after = (await a.query('SELECT to_jsonb(h) AS row FROM member_membership_history h')).rows[0].row;
    assert.deepEqual(after, before);
    await assert.rejects(a.query(`INSERT INTO membership_billing_agreements(tenant_id,member_id,term_start_date,status)
      VALUES ($1,$2,current_date+61,'active')`, [before.tenant_id, before.member_id]), /another reserved/);
    await assert.rejects(a.query(`INSERT INTO member_membership_history(tenant_id,member_id,term_start_date,status)
      VALUES ($1,$2,current_date+61,'active')`, [before.tenant_id, before.member_id]), /another reserved/);
    await a.query(await readFile(new URL('../../supabase/migrations/20261202_membership_successor_payment_attempts.sql', import.meta.url), 'utf8'));
    const q = (await a.query(`INSERT INTO membership_payment_quote(tenant_id,member_id,quote,stripe_payment_intent_id)
      VALUES($1,$2,'{}','pi_cancelled') RETURNING id`, [winner.tenant_id, winner.member_id])).rows[0].id;
    await a.query(`INSERT INTO membership_successor_election(
      tenant_id,member_id,previous_term_id,term_start_date,term_end_date,payment_method,origin,quote,payment_quote_id)
      VALUES($1,$2,$3,current_date+500,current_date+864,'upfront','form','{}',$4)`,
    [winner.tenant_id, winner.member_id, winner.previous_term_id, q]);
    await Promise.all(clients.map(client => client.query('SET ROLE service_role')));
    const reserve = 'SELECT reserve_successor_payment_attempt($1,$2,$3) AS attempt';
    const attempts = await Promise.all(clients.map(client =>
      client.query(reserve, [winner.tenant_id, q, 'pi_cancelled'])));
    assert.equal(attempts[0].rows[0].attempt.id, attempts[1].rows[0].attempt.id);
    const attemptId = attempts[0].rows[0].attempt.id;
    await assert.rejects(a.query(reserve, [winner.tenant_id, q, 'pi_unknown']), /reconciled/);
    await assert.rejects(a.query('UPDATE membership_successor_payment_attempt SET provider_intent_id=$1', ['pi_illegal']), /permission denied/);
    const bind = 'SELECT bind_successor_payment_attempt($1,$2,$3,$4)';
    await a.query(bind, [winner.tenant_id, q, attemptId, 'pi_replacement']);
    await a.query(bind, [winner.tenant_id, q, attemptId, 'pi_replacement']);
    await assert.rejects(a.query(bind, [winner.tenant_id, q, attemptId, 'pi_other']), /mismatch/);
    const next = (await a.query(reserve, [winner.tenant_id, q, 'pi_replacement'])).rows[0].attempt;
    assert.equal(next.attempt_number, 2);
    await a.query('RESET ROLE');
    for (const role of ['anon', 'authenticated']) {
      await a.query(`SET ROLE ${role}`);
      await assert.rejects(a.query(reserve, [winner.tenant_id, q, 'pi_replacement']), /permission denied/);
      await a.query('RESET ROLE');
    }
    await a.query(await readFile(new URL('../../supabase/migrations/20261203_membership_successor_unused_release.sql', import.meta.url), 'utf8'));
    const unused = (await a.query(`INSERT INTO membership_successor_election(
      tenant_id,member_id,previous_term_id,term_start_date,term_end_date,payment_method,origin,quote,created_at)
      VALUES($1,$2,$3,current_date+1000,current_date+1364,'direct_debit','form',$4,now()-interval '1 hour') RETURNING *`,
    [winner.tenant_id, winner.member_id, winner.previous_term_id, { payerMemberId: winner.member_id }])).rows[0];
    const releaseSql = 'SELECT release_unused_membership_successor($1,$2,$3) AS released';
    await assert.rejects(a.query(releaseSql, [winner.tenant_id, unused.id, winner.previous_term_id]), /payer/);
    await b.query('RESET ROLE');
    const releaseRace = await Promise.allSettled([
      a.query(releaseSql, [winner.tenant_id, unused.id, winner.member_id]),
      b.query(`INSERT INTO membership_billing_agreements(tenant_id,member_id,term_start_date,status,membership_successor_election_id)
        VALUES($1,$2,current_date+1000,'mandate_pending',$3)`, [winner.tenant_id, winner.member_id, unused.id]),
    ]);
    assert.equal(releaseRace[0].status, 'fulfilled');
    if (releaseRace[0].value.rows[0].released) {
      assert.equal(releaseRace[1].status, 'rejected');
      await assert.rejects(a.query(`INSERT INTO membership_payment_quote(tenant_id,member_id,quote)
        VALUES($1,$2,$3)`, [winner.tenant_id, winner.member_id,
        { simResult: { formRenewalElectionId: unused.id } }]), /released/);
    } else {
      assert.equal(releaseRace[1].status, 'fulfilled');
      assert.equal((await a.query(releaseSql, [winner.tenant_id, unused.id, winner.member_id])).rows[0].released, false);
    }
    assert.equal((await a.query('SELECT stripe_payment_intent_id FROM membership_payment_quote WHERE id=$1', [q])).rows[0].stripe_payment_intent_id, 'pi_cancelled',
      'replacement ledger never overwrites the original provider identity');
    await a.query('RESET ROLE');
    await a.query('UPDATE membership_successor_rollout SET enabled=false');
    await a.query(await readFile(new URL('../../supabase/migrations/20261205_membership_successor_tenant_rollout.sql', import.meta.url), 'utf8'));
    const otherTenant = '00000000-0000-4000-8000-000000000099';
    await a.query('INSERT INTO tenant(id) VALUES($1)', [otherTenant]);
    assert.equal((await a.query('SELECT membership_successor_elections_enabled() enabled')).rows[0].enabled, false);
    assert.equal((await a.query('SELECT membership_successor_elections_enabled($1) enabled', [winner.tenant_id])).rows[0].enabled, false);
    await a.query('INSERT INTO membership_successor_tenant_rollout(tenant_id,enabled) VALUES($1,true)', [winner.tenant_id]);
    assert.equal((await a.query('SELECT membership_successor_elections_enabled($1) enabled', [winner.tenant_id])).rows[0].enabled, true);
    assert.equal((await a.query('SELECT membership_successor_elections_enabled($1) enabled', [otherTenant])).rows[0].enabled, false);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await a.query(`SET ROLE ${role}`);
      await assert.rejects(a.query('UPDATE membership_successor_tenant_rollout SET enabled=true'), /permission denied/);
      await a.query('RESET ROLE');
    }
    await a.query('SET ROLE service_role');
    await assert.rejects(a.query(`SELECT reserve_membership_successor($1,NULL,NULL,NULL,current_date,current_date+365,'upfront','form','{}')`, [otherTenant]), /not enabled/i);
    assert.equal((await a.query('SELECT membership_successor_elections_enabled($1) enabled', [winner.tenant_id])).rows[0].enabled, true);
  } finally {
    await Promise.all(clients.map(client => client.end()));
    if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(dir, { recursive: true, force: true });
  }
});