import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('mapped schedule migration compiles and restricts selections and execution privileges', async () => {
  const h = await createLocalPostgresHarness('mapped-renewal-');
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  let db, started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    run('pg_ctl', ['-D', h.data, '-l', `${h.root}/postgres.log`,
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, database: 'postgres', user: 'postgres' }); await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE form(id uuid,tenant_id uuid,fields jsonb,is_active boolean,
        require_authentication boolean,deactivate_at timestamptz);
      CREATE TABLE membership_tier_config(id uuid,tenant_id uuid,structure_scope_type text,
        billing_period text,start_mode text,is_active boolean,effective_from date,effective_to date);
      CREATE FUNCTION reserve_membership_successor(p_tenant_id uuid,p_member_id uuid,p_organization_id uuid,
        previous uuid,p_start date,p_end date,p_origin text,method text,p_quote jsonb)
      RETURNS boolean LANGUAGE plpgsql AS $$
      DECLARE policy jsonb := '{"assigned_config_id":"original"}';
      BEGIN
        -- public.form_expiry_only_renewal_policy(prior,p_tenant_id,p_member_id)
        IF p_origin <> 'form'
          OR p_quote#>>'{simulation,config,id}' IS DISTINCT FROM policy->>'assigned_config_id'
        THEN RETURN false; END IF;
        RETURN true;
      END $$;
    `);
    await db.query(readFileSync('supabase/migrations/20261207_expiry_only_mapped_form_renewal.sql', 'utf8'));
    const tenant = '00000000-0000-4000-8000-000000000001';
    const form = '00000000-0000-4000-8000-000000000002';
    const config = '00000000-0000-4000-8000-000000000003';
    const fields = [
      { id: 'answer', type: 'radio', options: ['Associate', 'Overseas associate'] },
      { id: 'payment', type: 'membership_payment', membership_schedule_mapping: {
        source_field_id: 'answer', entries: [{ value: 'Associate', config_id: config }] } },
    ];
    await db.query('INSERT INTO form VALUES($1,$2,$3,true,true,null)', [form, tenant, JSON.stringify(fields)]);
    await db.query(`INSERT INTO membership_tier_config VALUES($1,$2,'member','annual','immediate',true,null,null)`, [config, tenant]);
    const quote = { simulation: { config: { id: config }, formRenewal: {
      successorStart: '2026-10-06',
      selection: { formId: form, paymentFieldId: 'payment', configId: config, sourceValue: 'Associate' },
    } } };
    const allowed = async (q = quote, t = tenant) => (await db.query(
      'SELECT form_expiry_only_mapped_schedule_allowed($1,$2) ok', [t, q])).rows[0].ok;
    assert.equal(await allowed(), true);
    for (const [key, value] of [['formId', config], ['paymentFieldId', 'wrong'],
      ['sourceValue', 'Overseas associate'], ['configId', form]]) {
      const forged = structuredClone(quote);
      forged.simulation.formRenewal.selection[key] = value;
      assert.equal(await allowed(forged), false, key);
    }
    assert.equal(await allowed(quote, form), false);
    await db.query(`UPDATE membership_tier_config SET effective_from='2027-01-01'`);
    assert.equal(await allowed(), false);
    await db.query('UPDATE membership_tier_config SET effective_from=null');
    assert.equal((await db.query(
      `SELECT reserve_membership_successor($1,null,null,null,'2026-10-06','2027-10-05','form','upfront',$2) ok`,
      [tenant, quote])).rows[0].ok, true);
    await db.query('UPDATE form SET require_authentication=false');
    assert.equal(await allowed(), false);
    await db.query('UPDATE form SET require_authentication=true,is_active=false');
    assert.equal(await allowed(), false);
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query(`SELECT has_function_privilege($1,
        'form_expiry_only_mapped_schedule_allowed(uuid,jsonb)','execute') ok`, [role])).rows[0].ok, false);
    }
    assert.equal((await db.query(`SELECT has_function_privilege('service_role',
      'form_expiry_only_mapped_schedule_allowed(uuid,jsonb)','execute') ok`)).rows[0].ok, true);
  } finally {
    await db?.end();
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});
