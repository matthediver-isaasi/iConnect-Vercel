import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

test('switch database protocol fences creators, scopes payers and retains immutable attempts', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'renewal-switch-'));
  const cluster = join(dir, 'data');
  const clients = [];
  let started = false;
  const tenant = '10000000-0000-4000-8000-000000000001';
  const member = '20000000-0000-4000-8000-000000000001';
  const election = '30000000-0000-4000-8000-000000000001';
  const quote = '40000000-0000-4000-8000-000000000001';
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(dir, 'log'), '-o', `-k ${dir} -p 55497 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    for (let i = 0; i < 2; i++) {
      const db = new pg.Client({ host: dir, port: 55497, database: 'postgres', user: 'runner' });
      await db.connect();
      clients.push(db);
    }
    const [a, b] = clients;
    await a.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE member(id uuid,tenant_id uuid,organization_id uuid);
      CREATE TABLE membership_successor_election(id uuid PRIMARY KEY,tenant_id uuid,
        member_id uuid,organization_id uuid,origin text,quote jsonb,status text,payment_quote_id uuid);
      CREATE TABLE membership_payment_quote(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        organization_id uuid,term_key text,quote jsonb,stripe_payment_intent_id text);
      CREATE UNIQUE INDEX membership_payment_quote_member_term_uniq ON membership_payment_quote(tenant_id,member_id,term_key);
      CREATE UNIQUE INDEX membership_payment_quote_org_term_uniq ON membership_payment_quote(tenant_id,organization_id,term_key);
      CREATE TABLE membership_successor_payment_attempt(id uuid PRIMARY KEY,tenant_id uuid,quote_id uuid,attempt_number integer,provider_intent_id text);
      CREATE TABLE membership_billing_agreements(id uuid,membership_successor_election_id uuid,status text);
      CREATE EXTENSION btree_gist;
      CREATE TABLE member_membership_history(id uuid,membership_successor_election_id uuid,status text,
        tenant_id uuid,member_id uuid,membership_year text,term_key text,previous_term_id uuid,
        term_start_date date,membership_renewal_date date);
      CREATE TABLE organisation_membership_history(LIKE member_membership_history);
      ALTER TABLE organisation_membership_history RENAME COLUMN member_id TO organization_id;
      DO $f$ DECLARE t text; owner_col text; BEGIN
        FOREACH t IN ARRAY ARRAY['member_membership_history','organisation_membership_history'] LOOP
          owner_col:=CASE WHEN t='member_membership_history' THEN 'member_id' ELSE 'organization_id' END;
          EXECUTE format('CREATE UNIQUE INDEX %I ON %I(tenant_id,%I,term_key) WHERE term_key IS NOT NULL',t || '_rolling_term_uniq',t,owner_col);
          EXECUTE format('CREATE UNIQUE INDEX %I ON %I(tenant_id,previous_term_id) WHERE previous_term_id IS NOT NULL',t || '_rolling_successor_uniq',t);
          EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I EXCLUDE USING gist
            (tenant_id WITH =,%I WITH =,daterange(term_start_date,membership_renewal_date,''[)'') WITH &&)
            WHERE (term_key IS NOT NULL)',t,t || '_rolling_no_overlap',owner_col);
        END LOOP;
      END $f$;
      CREATE UNIQUE INDEX member_membership_history_member_year_uniq ON member_membership_history(tenant_id,member_id,membership_year) WHERE term_key IS NULL;
      CREATE UNIQUE INDEX organisation_membership_history_org_year_uniq ON organisation_membership_history(tenant_id,organization_id,membership_year) WHERE term_key IS NULL;
      CREATE TABLE membership_payment_plans(id uuid,billing_agreement_id uuid);
      CREATE FUNCTION reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb)
        RETURNS void LANGUAGE plpgsql AS $f$ DECLARE p_tenant_id uuid; BEGIN
          PERFORM 1 FROM membership_payment_quote q WHERE q.tenant_id=p_tenant_id;
        END $f$;
      CREATE FUNCTION enforce_rolling_membership_commitment() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN PERFORM 1 FROM membership_payment_quote q WHERE q.tenant_id = NULL;
          EXECUTE format('SELECT id FROM %I WHERE tenant_id IS NULL','member_membership_history'); RETURN NEW; END $f$;
      CREATE FUNCTION enforce_rolling_payment_quote() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN PERFORM 1 FROM membership_payment_quote q WHERE q.tenant_id = NULL;
          EXECUTE format('SELECT id FROM %I WHERE tenant_id IS NULL','member_membership_history'); RETURN NEW; END $f$;
      CREATE FUNCTION reserve_form_membership_payment_quote(uuid,uuid,uuid,jsonb)
        RETURNS void LANGUAGE plpgsql AS $f$ DECLARE p_tenant_id uuid; BEGIN
          PERFORM 1 FROM membership_payment_quote WHERE tenant_id=p_tenant_id AND term_key IS NOT NULL;
          PERFORM 1 FROM membership_payment_quote WHERE tenant_id=p_tenant_id AND term_key IS NOT NULL;
          EXECUTE format('SELECT id FROM %I WHERE tenant_id IS NULL','member_membership_history');
        END $f$;
    `);
    await a.query(await readFile(new URL('../../supabase/migrations/20261207_membership_successor_switch.sql', import.meta.url), 'utf8'));
    await a.query('INSERT INTO member VALUES($1,$2,NULL)', [member, tenant]);
    await a.query(`INSERT INTO membership_successor_election(id,tenant_id,member_id,origin,quote,status,payment_quote_id)
      VALUES($1,$2,$3,'form',$4,'reserved',$5)`,
    [election, tenant, member, { payerMemberId: member }, quote]);
    await a.query(`INSERT INTO membership_payment_quote(id,tenant_id,member_id,quote,stripe_payment_intent_id)
      VALUES($1,$2,$3,$4,'pi_original')`, [quote, tenant, member,
      { stripeEnvironment: 'test', simResult: { formRenewalElectionId: election } }]);
    const scope = [tenant, election, member, null];
    const begin = 'SELECT begin_membership_successor_switch($1,$2,$3,$4) snapshot';
    await assert.rejects(a.query(begin, [tenant, election, tenant, null]), /payer and owner/);
    // An organisation affiliation must not change ownership of a personal term.
    await a.query('BEGIN');
    await a.query('UPDATE member SET organization_id=$1 WHERE id=$2',[tenant,member]);
    await a.query(begin,[tenant,election,member,tenant]);
    await a.query('ROLLBACK');
    const token = (await a.query('SELECT begin_membership_successor_provider_work($1,$2) token', [tenant, election])).rows[0].token;
    await a.query("UPDATE membership_payment_quote SET stripe_payment_intent_id=NULL WHERE id=$1",[quote]);
    await assert.rejects(b.query(begin, scope), /unresolved/);
    await a.query("UPDATE membership_payment_quote SET stripe_payment_intent_id='pi_original' WHERE id=$1",[quote]);
    await a.query('SELECT finish_membership_successor_provider_work($1,$2,$3)', [tenant, election, token]);
    await a.query('BEGIN');
    await a.query(begin, scope);
    let settled = false;
    const concurrent = b.query('SELECT begin_membership_successor_provider_work($1,$2)', [tenant, election])
      .then(() => { settled = true; return null; }, error => { settled = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false, 'creator waits for the switch row lock');
    await a.query('COMMIT');
    assert.match((await concurrent).message, /fenced/);
    await assert.rejects(a.query('INSERT INTO member_membership_history(id,membership_successor_election_id) VALUES(gen_random_uuid(),$1)', [election]), /changing/);
    await assert.rejects(a.query(`INSERT INTO membership_successor_payment_attempt
      VALUES(gen_random_uuid(),$1,$2,1,'pi_stale')`, [tenant, quote]), /changing/);
    await assert.rejects(a.query('SELECT finish_membership_successor_switch($1,$2,$3,$4,$5)', [...scope, '[]']), /every attempt/);
    const receipts = JSON.stringify([{ id: 'pi_original', status: 'canceled', livemode: false }]);
    await a.query('SELECT finish_membership_successor_switch($1,$2,$3,$4,$5)', [...scope, receipts]);
    assert.equal((await a.query(begin, scope)).rows[0].snapshot.released, true);
    const saved = (await a.query('SELECT * FROM membership_payment_quote WHERE id=$1', [quote])).rows[0];
    assert.equal(saved.stripe_payment_intent_id, 'pi_original');
    assert.ok(saved.cancelled_for_switch_at);
    await assert.rejects(a.query(`UPDATE membership_payment_quote SET stripe_payment_intent_id='pi_late' WHERE id=$1`, [quote]), /released/);
    await a.query('SET ROLE authenticated');
    await assert.rejects(a.query(begin, scope), /permission denied/);
  } finally {
    await Promise.all(clients.map(client => client.end().catch(() => {})));
    if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(dir, { recursive: true, force: true });
  }
});
