import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { buildRollingCommitment, recoverRollingCommitment, applyRecoveredRollingCommitment } from './rollingMembershipCommitment.js';

// Only a disposable UNIX-socket cluster is used. No DATABASE_URL is read and
// no application, external DB, provider, email or workflow is started.
test('rolling commitment migration and atomic guards on isolated PostgreSQL', { timeout: 120000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rolling-commitment-pg-'));
  const cluster = join(dir, 'data');
  const options = { host: dir, port: 55482, user: 'runner', database: 'postgres' };
  let running = false;
  const clients = [];
  const connect = async () => {
    const client = new pg.Client(options);
    await client.connect();
    clients.push(client);
    return client;
  };
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(dir, 'postgres.log'), '-o', `-k ${dir} -p 55482 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    const db = await connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant (id uuid PRIMARY KEY);
      CREATE TABLE member (id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE organization (id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE membership_tier_config (id uuid PRIMARY KEY, tenant_id uuid, start_mode text, structure_scope_type text);
      CREATE TABLE membership_billing_agreements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, member_id uuid, organization_id uuid,
        agreement_type text DEFAULT 'member', provider text, metadata jsonb, status text DEFAULT 'active',
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE member_membership_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, member_id uuid,
        membership_year text, config_id uuid, band_id uuid, annual_cost numeric, final_cost numeric,
        currency text, vat_amount numeric, total_with_vat numeric, vat_rate_percent numeric,
        billing_period text, payment_method text, billing_agreement_id uuid, stripe_payment_intent_id text,
        prorata_cost numeric, free_period_discount numeric, rollover_discount numeric,
        custom_discount_total numeric, custom_discount_details jsonb,
        status text DEFAULT 'active', payment_status text DEFAULT 'unpaid',
        created_at timestamptz DEFAULT now(), term_start_date date, term_end_date date
      );
      CREATE TABLE organisation_membership_history (LIKE member_membership_history INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
      ALTER TABLE organisation_membership_history RENAME COLUMN member_id TO organization_id;
      CREATE UNIQUE INDEX member_membership_history_member_year_uniq ON member_membership_history(tenant_id,member_id,membership_year);
      CREATE UNIQUE INDEX organisation_membership_history_org_year_uniq ON organisation_membership_history(tenant_id,organization_id,membership_year);
      CREATE UNIQUE INDEX member_membership_history_billing_agreement_uniq ON member_membership_history(billing_agreement_id) WHERE billing_agreement_id IS NOT NULL;
      INSERT INTO tenant VALUES ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
      INSERT INTO member VALUES
        ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001'),
        ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001'),
        ('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000002');
      INSERT INTO organization VALUES ('00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000001');
      INSERT INTO membership_tier_config VALUES
        ('00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000001','immediate','member'),
        ('00000000-0000-0000-0000-000000000032','00000000-0000-0000-0000-000000000001','immediate','organization'),
        ('00000000-0000-0000-0000-000000000033','00000000-0000-0000-0000-000000000001','fixed_date','member');
    `);
    // Includes the prerequisite upfront-quote table owned by the commencement worker.
    await db.query(await readFile(new URL('../../supabase/migrations/20260919_form_membership_payment_quote.sql', import.meta.url), 'utf8'));
    // Genuine legacy shapes, inserted before the new integrity triggers exist.
    const uuid = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
    const legacySeed = [];
    for (let i = 0; i < 7; i += 1) {
      const organization = i === 6;
      const legacyConfig = {
        id: uuid(organization ? 32 : 31), tenant_id: uuid(1), start_mode: 'immediate',
        structure_scope_type: organization ? 'organization' : 'member', billing_period: 'monthly', currency: 'GBP',
      };
      const financials = { annual_cost: 20, final_cost: 20, vat_amount: 0, total_with_vat: 20, currency: 'GBP', monthly_amount: 20, instalment_count: 1 };
      const consent = {
        config_id: legacyConfig.id, config_snapshot: legacyConfig,
        membership_year_start: `2023-${String(i + 1).padStart(2, '0')}-15`, ...financials,
      };
      if (i === 4) delete consent.config_snapshot; // Ambiguous: only editable config ID.
      const ownerColumn = organization ? 'organization_id' : 'member_id';
      const table = organization ? 'organisation_membership_history' : 'member_membership_history';
      await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,${ownerColumn},agreement_type,provider,metadata)
        VALUES($1,$2,$3,$4,'gocardless',$5)`, [uuid(201 + i), uuid(1), uuid(organization ? 21 : 11), organization ? 'organization' : 'member', { dd: consent }]);
      await db.query(`INSERT INTO ${table}(id,tenant_id,${ownerColumn},membership_year,config_id,billing_agreement_id,annual_cost,final_cost,vat_amount,total_with_vat,currency,payment_method,billing_period)
        VALUES($1,$2,$3,$4,$5,$6,20,20,0,20,'GBP','direct_debit','monthly_direct_debit')`,
      [uuid(101 + i), uuid(1), uuid(organization ? 21 : 11), `legacy-${i}`, legacyConfig.id, uuid(201 + i)]);
      legacySeed.push({ id: uuid(101 + i), agreementId: uuid(201 + i), table, organization });
    }
    const legacyQuote = {
      config_id: uuid(31),
      config_snapshot: { id: uuid(31), start_mode: 'immediate', structure_scope_type: 'member', billing_period: 'annual', currency: 'GBP' },
      membership_start_date: '2021-09-15', payment_method: 'stripe', payment_frequency: 'upfront',
      annual_cost: 240, final_cost: 240, vat_amount: 0, total_with_vat: 240, currency: 'GBP',
    };
    await db.query('INSERT INTO membership_payment_quote(id,tenant_id,member_id,stripe_payment_intent_id,quote) VALUES($1,$2,$3,$4,$5)', [
      uuid(301), uuid(1), uuid(11), 'pi_legacy_recovery_fixture', legacyQuote,
    ]);
    await db.query(`INSERT INTO member_membership_history(id,tenant_id,member_id,membership_year,config_id,annual_cost,final_cost,vat_amount,total_with_vat,currency,payment_method,stripe_payment_intent_id)
      VALUES($1,$2,$3,'legacy-upfront',$4,240,240,0,240,'GBP','stripe','pi_legacy_recovery_fixture')`, [uuid(108), uuid(1), uuid(11), uuid(31)]);
    const migration = await readFile(new URL('../../supabase/migrations/20260920_rolling_membership_commitments.sql', import.meta.url), 'utf8');
    await db.query(migration);
    await db.query(migration); // Repeatable deployment, not only an empty DB.
    const recoveryMigration = await readFile(new URL('../../supabase/migrations/20260921_rolling_membership_recovery.sql', import.meta.url), 'utf8');
    await db.query(recoveryMigration);
    await db.query(recoveryMigration);
    const tenant = '00000000-0000-0000-0000-000000000001';
    const member = '00000000-0000-0000-0000-000000000011';
    const otherMember = '00000000-0000-0000-0000-000000000012';
    const org = '00000000-0000-0000-0000-000000000021';
    const config = {
      id: '00000000-0000-0000-0000-000000000031', tenant_id: tenant,
      start_mode: 'immediate', structure_scope_type: 'member', billing_period: 'monthly', currency: 'GBP',
    };
    const amounts = { annual_cost: 20, final_cost: 20, vat_amount: 0, total_with_vat: 20, currency: 'GBP' };
    const record = (date, options = {}) => {
      const tier = options.config || config;
      return {
        ...buildRollingCommitment({ config: tier, startDate: date, previousTerm: options.previousTerm,
          paymentMethod: 'stripe', paymentFrequency: 'upfront', amounts }),
        config_id: tier.id, ...amounts, billing_period: 'annual', payment_method: 'stripe',
      };
    };
    const insert = async (row, owner = member, organization = null, connection = db) => (
      await connection.query('SELECT insert_rolling_membership_commitment($1,$2,$3,$4) AS value', [tenant, owner, organization, row])
    ).rows[0].value;
    const rawInsert = async (table, row, connection = db) => {
      const keys = Object.keys(row);
      return connection.query(`INSERT INTO ${table} (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row));
    };
    const loadLegacy = async (index) => {
      const seed = legacySeed[index];
      return {
        history: (await db.query(`SELECT to_jsonb(x) AS data FROM ${seed.table} x WHERE id=$1`, [seed.id])).rows[0].data,
        agreement: (await db.query('SELECT to_jsonb(x) AS data FROM membership_billing_agreements x WHERE id=$1', [seed.agreementId])).rows[0].data,
      };
    };
    const recoveryRpc = {
      rpc: async (_name, params) => ({ data: (await db.query('SELECT recover_rolling_membership_commitment($1,$2,$3,$4,$5,$6,$7) AS data', [
        params.p_tenant_id, params.p_history_type, params.p_history_id, params.p_expected_history,
        params.p_expected_agreement, params.p_expected_quote, params.p_commitment,
      ])).rows[0].data }),
    };
    let first;
    await t.test('same-calendar-year purchases are adjacent, month-end anchored, and retries idempotent', async () => {
      const row = record('2027-01-31');
      const result = await insert(row);
      first = result.record;
      assert.equal(first.membership_year, row.term_key);
      assert.equal(first.membership_renewal_date, '2027-02-28');
      assert.equal((await insert(row)).idempotent, true);
      await assert.rejects(() => insert({ ...row, final_cost: 25 }), /Retry differs/);
      const second = await insert(record('2027-02-28', { previousTerm: first }));
      assert.equal(second.record.membership_renewal_date, '2027-03-31');
      assert.equal(second.record.previous_term_id, first.id);
      await assert.rejects(() => insert(record('2027-02-15')), /overlap|conflicting key/i);
    });
    await t.test('immutability protects money, dates and tenant/entity ownership, not payment status', async () => {
      for (const [column, value] of [['final_cost', 25], ['term_start_date', '2027-02-01'], ['member_id', otherMember]]) {
        await assert.rejects(() => db.query(`UPDATE member_membership_history SET ${column}=$1 WHERE id=$2`, [value, first.id]), /immutable/);
      }
      await db.query("UPDATE member_membership_history SET payment_status='paid' WHERE id=$1", [first.id]);
      await assert.rejects(() => insert(record('2028-01-01'), '00000000-0000-0000-0000-000000000013'), /tenant/);
      await assert.rejects(() => insert({ ...record('2028-01-01'), final_cost: 1 }), /differs/);
      await assert.rejects(() => insert(record('2028-02-01', { previousTerm: { ...first, membership_renewal_date: '2028-02-01' } })), /adjacent/);
    });
    await t.test('fixed-cycle unique year guard survives and immediate paths cannot omit dates', async () => {
      const fixed = { tenant_id: tenant, member_id: otherMember, membership_year: '2026/2027', config_id: '00000000-0000-0000-0000-000000000033' };
      await rawInsert('member_membership_history', fixed);
      await assert.rejects(() => rawInsert('member_membership_history', fixed), /duplicate/);
      await assert.rejects(() => rawInsert('member_membership_history', { ...fixed, membership_year: '2027/2028', config_id: config.id }), /dated commitment/);
    });
    await t.test('invoice-first upfront settlement records the actual rail without changing the agreed snapshot', async () => {
      for (const initialMethod of [null, 'invoice']) {
        const row = record(initialMethod === null ? '2034-01-01' : '2034-02-01');
        row.commitment_snapshot.payment_method = 'invoice';
        row.payment_method = initialMethod;
        const saved = await insert(row);
        await db.query("UPDATE member_membership_history SET payment_method='stripe',payment_status='paid' WHERE id=$1", [saved.record.id]);
        const settled = (await db.query('SELECT * FROM member_membership_history WHERE id=$1', [saved.record.id])).rows[0];
        assert.equal(settled.payment_method, 'stripe');
        assert.equal(settled.commitment_snapshot.payment_method, 'invoice');
        assert.equal(settled.commitment_snapshot.payment_frequency, 'upfront');
        assert.equal((await insert(row)).idempotent, true);
        await assert.rejects(() => db.query("UPDATE member_membership_history SET payment_method='bank_transfer' WHERE id=$1", [saved.record.id]), /immutable/);
        await assert.rejects(() => db.query("UPDATE member_membership_history SET payment_method='card_monthly' WHERE id=$1", [saved.record.id]), /immutable/);
      }
    });
    await t.test('agreement snapshot copies into legacy-style history insertion and is immutable under provider callbacks', async () => {
      const commitment = record('2027-05-31');
      const consent = Object.fromEntries(Object.entries(commitment).filter(([key]) => key.startsWith('term_') || ['membership_renewal_date', 'previous_term_id', 'commitment_snapshot'].includes(key)));
      const agreement = (await rawInsert('membership_billing_agreements', {
        tenant_id: tenant, member_id: otherMember, provider: 'stripe',
        metadata: { card: { commitment: consent, monthly_amount: 20, config_id: config.id } },
      })).rows[0];
      assert.equal(agreement.term_key, consent.term_key);
      await assert.rejects(() => rawInsert('membership_billing_agreements', {
        tenant_id: tenant, member_id: otherMember, provider: 'gocardless',
        metadata: { dd: { commitment: consent } },
      }), /overlapping/);
      const historyRow = (await rawInsert('member_membership_history', {
        tenant_id: tenant, member_id: otherMember, billing_agreement_id: agreement.id,
        membership_year: '2027/2028', ...amounts, config_id: config.id,
      })).rows[0];
      assert.equal(historyRow.term_key, consent.term_key);
      await db.query("UPDATE membership_tier_config SET structure_scope_type='organization' WHERE id=$1", [config.id]);
      await db.query("UPDATE membership_billing_agreements SET status='payment_overdue' WHERE id=$1", [agreement.id]);
      await db.query("UPDATE member_membership_history SET payment_status='paid' WHERE id=$1", [historyRow.id]);
      await assert.rejects(() => db.query(`UPDATE membership_billing_agreements SET metadata=jsonb_set(metadata,'{card,monthly_amount}','25') WHERE id=$1`, [agreement.id]), /immutable/);
      await db.query(`UPDATE membership_billing_agreements SET metadata=jsonb_set(metadata,'{renewal_result}','"queued"') WHERE id=$1`, [agreement.id]);
      await db.query("UPDATE membership_tier_config SET structure_scope_type='member' WHERE id=$1", [config.id]);
    });
    await t.test('organisation purchases enforce scope, overlap and agreement identity', async () => {
      const orgConfig = { ...config, id: '00000000-0000-0000-0000-000000000032', structure_scope_type: 'organization' };
      const orgTerm = await insert(record('2027-01-31', { config: orgConfig }), null, org);
      assert.equal(orgTerm.record.organization_id, org);
      await assert.rejects(() => insert(record('2027-02-01', { config: orgConfig }), null, org), /overlap|conflicting key/i);
      await assert.rejects(() => insert(record('2027-05-01'), null, org), /scope/);
    });
    await t.test('upfront reservations block both monthly providers and accept only their bound payment', async () => {
      const row = record('2028-03-01');
      const consent = Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith('term_') || ['membership_renewal_date', 'previous_term_id', 'commitment_snapshot'].includes(key)));
      const quote = { simResult: { commitment: consent, config, membershipYear: { label: consent.term_key } } };
      const saved = (await db.query('SELECT reserve_form_membership_payment_quote($1,$2,NULL,$3) AS quote', [tenant, member, quote])).rows[0].quote;
      const replay = (await db.query('SELECT reserve_form_membership_payment_quote($1,$2,NULL,$3) AS quote', [tenant, member, quote])).rows[0].quote;
      assert.equal(saved.id, replay.id);
      for (const provider of ['stripe', 'gocardless']) {
        await assert.rejects(() => rawInsert('membership_billing_agreements', {
          tenant_id: tenant, member_id: member, provider, metadata: { commitment: consent },
        }), /upfront payment.*reserves/);
      }
      await assert.rejects(() => insert(row), /upfront payment.*reserves/);
      await db.query('SELECT bind_form_membership_payment_quote($1,$2,$3)', [saved.id, tenant, 'pi_isolated_fixture']);
      await assert.rejects(() => insert({ ...row, membership_payment_quote_id: saved.id, stripe_payment_intent_id: 'pi_foreign' }), /does not match/);
      const settled = await insert({ ...row, membership_payment_quote_id: saved.id, stripe_payment_intent_id: 'pi_isolated_fixture' });
      assert.equal(settled.record.membership_payment_quote_id, saved.id);
      await db.query("UPDATE member_membership_history SET payment_status='paid' WHERE id=$1", [settled.record.id]);
      await assert.rejects(() => db.query(`UPDATE membership_payment_quote SET quote=jsonb_set(quote,'{simResult,commitment,term_start_date}','"2028-03-02"') WHERE id=$1`, [saved.id]), /immutable/);
    });
    await t.test('atomic insert RPC is service-role-only and rejects malformed snapshots', async () => {
      await db.query('SET ROLE authenticated');
      await assert.rejects(() => insert(record('2030-01-01')), /permission denied/);
      await db.query('RESET ROLE');
      const invalid = record('2030-01-01');
      invalid.term_duration_months = null;
      await assert.rejects(() => insert(invalid), /billing period|check constraint/);
      const inconsistent = record('2030-01-01');
      inconsistent.membership_renewal_date = '2030-03-01';
      await assert.rejects(() => insert(inconsistent), /billing period/);
    });
    await t.test('concurrent overlapping inserts serialize before publishing a second purchase', async () => {
      const one = await connect();
      const two = await connect();
      await one.query('BEGIN');
      await insert(record('2029-01-01'), member, null, one);
      const competing = insert(record('2029-01-15'), member, null, two);
      // Attach rejection handling before releasing the lock.
      const rejected = assert.rejects(() => competing, /overlap|conflicting key/i);
      await one.query('COMMIT');
      await rejected;
      const count = await db.query("SELECT count(*) FROM member_membership_history WHERE term_start_date >= '2029-01-01' AND term_start_date < '2030-01-01'");
      assert.equal(count.rows[0].count, '1');
    });
    await t.test('concurrent upfront and provider reservations use the same transaction lock in both directions', async () => {
      const one = await connect();
      const two = await connect();
      const consentFor = (date) => Object.fromEntries(Object.entries(record(date))
        .filter(([key]) => key.startsWith('term_') || ['membership_renewal_date', 'previous_term_id', 'commitment_snapshot'].includes(key)));
      const consent = consentFor('2031-01-01');
      const quote = { simResult: { config, commitment: consent } };
      await one.query('BEGIN');
      await one.query('SELECT reserve_form_membership_payment_quote($1,$2,NULL,$3)', [tenant, member, quote]);
      const losingAgreement = rawInsert('membership_billing_agreements', {
        tenant_id: tenant, member_id: member, provider: 'gocardless', metadata: { commitment: consent },
      }, two);
      const rejectedAgreement = assert.rejects(() => losingAgreement, /upfront payment.*reserves/);
      await one.query('COMMIT');
      await rejectedAgreement;
      const next = consentFor('2032-01-01');
      await one.query('BEGIN');
      await rawInsert('membership_billing_agreements', {
        tenant_id: tenant, member_id: member, provider: 'stripe', metadata: { commitment: next },
      }, one);
      const losingQuote = two.query('SELECT reserve_form_membership_payment_quote($1,$2,NULL,$3)', [
        tenant, member, { simResult: { config, commitment: next } },
      ]);
      const rejectedQuote = assert.rejects(() => losingQuote, /monthly payment agreement/);
      await one.query('COMMIT');
      await rejectedQuote;
    });
    await t.test('safe legacy apply atomically recovers member and organisation consent, preserving amounts and auditing once', async () => {
      for (const index of [0, 6]) {
        const evidence = await loadLegacy(index);
        assert.equal(recoverRollingCommitment(evidence).status, 'recoverable');
        const applied = await applyRecoveredRollingCommitment(recoveryRpc, { tenantId: tenant, evidence });
        assert.equal(applied.status, 'recovered');
        const updated = await loadLegacy(index);
        assert.equal(updated.history.term_key, updated.agreement.term_key);
        assert.equal(updated.history.membership_renewal_date, index === 0 ? '2023-02-15' : '2023-08-15');
        for (const key of ['annual_cost', 'final_cost', 'vat_amount', 'total_with_vat', 'currency']) {
          assert.equal(updated.history[key], evidence.history[key]);
        }
        assert.deepEqual(updated.agreement.metadata, evidence.agreement.metadata);
        const replay = await applyRecoveredRollingCommitment(recoveryRpc, { tenantId: tenant, evidence });
        assert.equal(replay.status, 'already_recorded');
        const audit = await db.query('SELECT count(*) FROM rolling_membership_recovery_audit WHERE history_id=$1', [evidence.history.id]);
        assert.equal(audit.rows[0].count, '1');
      }
    });
    await t.test('legacy apply rejects stale exported financials and forged proposal terms without writing either row', async () => {
      const stale = await loadLegacy(1);
      await db.query('UPDATE member_membership_history SET final_cost=21 WHERE id=$1', [stale.history.id]);
      await assert.rejects(() => applyRecoveredRollingCommitment(recoveryRpc, { tenantId: tenant, evidence: stale }), /changed since/);
      assert.equal((await loadLegacy(1)).agreement.term_key, null);
      const evidence = await loadLegacy(2);
      const candidate = recoverRollingCommitment(evidence).patch;
      candidate.commitment_snapshot.amounts.monthly_amount = 25;
      await assert.rejects(() => recoveryRpc.rpc('recover_rolling_membership_commitment', {
        p_tenant_id: tenant, p_history_type: 'member', p_history_id: evidence.history.id,
        p_expected_history: evidence.history, p_expected_agreement: evidence.agreement,
        p_expected_quote: null, p_commitment: candidate,
      }), /collection terms differ/);
      const unchanged = await loadLegacy(2);
      assert.equal(unchanged.agreement.term_key, null);
      assert.equal(unchanged.history.term_key, null);
      await db.query(`UPDATE membership_billing_agreements SET metadata=jsonb_set(metadata,'{dd,monthly_amount}','25') WHERE id=$1`, [evidence.agreement.id]);
      await assert.rejects(() => applyRecoveredRollingCommitment(recoveryRpc, { tenantId: tenant, evidence }), /agreement ownership\/evidence changed/);
      await db.query('UPDATE membership_billing_agreements SET metadata=$1 WHERE id=$2', [evidence.agreement.metadata, evidence.agreement.id]);
    });
    await t.test('a failed history write rolls back the already-updated agreement and audit in the recovery transaction', async () => {
      const evidence = await loadLegacy(3);
      await db.query(`ALTER TABLE member_membership_history ADD CONSTRAINT simulated_recovery_write_failure CHECK (id <> '${evidence.history.id}' OR term_key IS NULL)`);
      await assert.rejects(() => applyRecoveredRollingCommitment(recoveryRpc, { tenantId: tenant, evidence }), /simulated_recovery_write_failure/);
      const unchanged = await loadLegacy(3);
      assert.equal(unchanged.history.term_key, null);
      assert.equal(unchanged.agreement.term_key, null);
      const audit = await db.query('SELECT count(*) FROM rolling_membership_recovery_audit WHERE history_id=$1', [evidence.history.id]);
      assert.equal(audit.rows[0].count, '0');
      await db.query('ALTER TABLE member_membership_history DROP CONSTRAINT simulated_recovery_write_failure');
    });
    await t.test('ambiguous recovery does not invoke writes and apply is tenant-scoped/service-role-only', async () => {
      const ambiguous = await loadLegacy(4);
      const review = await applyRecoveredRollingCommitment({ rpc: () => { throw new Error('must not be called'); } }, { tenantId: tenant, evidence: ambiguous });
      assert.equal(review.status, 'review');
      const evidence = await loadLegacy(5);
      await assert.rejects(() => applyRecoveredRollingCommitment(recoveryRpc, { tenantId: uuid(2), evidence }), /matching tenant/);
      await db.query('SET ROLE authenticated');
      await assert.rejects(() => applyRecoveredRollingCommitment(recoveryRpc, { tenantId: tenant, evidence }), /permission denied/);
      await db.query('RESET ROLE');
      assert.equal((await loadLegacy(5)).history.term_key, null);
    });
    await t.test('upfront legacy quote apply requires the bound PI and preserves the original quote verbatim', async () => {
      const evidence = {
        history: (await db.query('SELECT to_jsonb(x) AS data FROM member_membership_history x WHERE id=$1', [uuid(108)])).rows[0].data,
        quote: (await db.query('SELECT to_jsonb(x) AS data FROM membership_payment_quote x WHERE id=$1', [uuid(301)])).rows[0].data,
      };
      const candidate = recoverRollingCommitment(evidence);
      assert.equal(candidate.status, 'recoverable');
      const applied = await applyRecoveredRollingCommitment(recoveryRpc, { tenantId: tenant, evidence });
      assert.equal(applied.status, 'recovered');
      assert.equal(applied.record.membership_renewal_date, '2022-09-15');
      assert.equal(applied.record.membership_payment_quote_id, evidence.quote.id);
      const quote = (await db.query('SELECT to_jsonb(x) AS data FROM membership_payment_quote x WHERE id=$1', [evidence.quote.id])).rows[0].data;
      assert.deepEqual(quote.quote, evidence.quote.quote);
      assert.equal(quote.recovered_commitment.term_key, applied.record.term_key);
    });
    await t.test('the explicit tenant-scoped apply CLI executes the guarded RPC only against this disposable cluster', async () => {
      const evidence = await loadLegacy(5);
      const file = join(dir, 'reviewed-evidence.json');
      await writeFile(file, JSON.stringify([evidence]));
      const script = new URL('../../scripts/recover-rolling-membership-commitments.mjs', import.meta.url).pathname;
      const localUrl = `postgresql://runner@localhost:55482/postgres?host=${encodeURIComponent(dir)}`;
      const env = { ...process.env, DEST_DATABASE_URL: localUrl, DATABASE_URL: localUrl, PGSSLMODE: 'disable' };
      const preview = JSON.parse(execFileSync(process.execPath, [script, file, '--tenant', tenant], { encoding: 'utf8', env }));
      assert.equal(preview.dry_run, true);
      assert.equal((await loadLegacy(5)).history.term_key, null);
      const applied = JSON.parse(execFileSync(process.execPath, [script, file, '--tenant', tenant, '--apply'], { encoding: 'utf8', env }));
      assert.equal(applied.dry_run, false);
      assert.equal(applied.results[0].status, 'recovered');
      assert.equal((await loadLegacy(5)).history.membership_renewal_date, '2023-07-15');
      const replay = JSON.parse(execFileSync(process.execPath, [script, file, '--tenant', tenant, '--apply'], { encoding: 'utf8', env }));
      assert.equal(replay.results[0].status, 'already_recorded');
    });
    await t.test('concurrent recovery retries produce one update/audit and reject cross-tenant direct RPC calls', async () => {
      const evidence = await loadLegacy(2);
      const candidate = recoverRollingCommitment(evidence).patch;
      const params = [tenant, 'member', evidence.history.id, evidence.history, evidence.agreement, null, candidate];
      const sql = 'SELECT recover_rolling_membership_commitment($1,$2,$3,$4,$5,$6,$7) AS data';
      await assert.rejects(() => db.query(sql, [uuid(2), ...params.slice(1)]), /not found in selected tenant/);
      const one = await connect();
      const two = await connect();
      const results = await Promise.all([one.query(sql, params), two.query(sql, params)]);
      assert.deepEqual(results.map((result) => result.rows[0].data.status).sort(), ['already_recorded', 'recovered']);
      const audit = await db.query('SELECT count(*) FROM rolling_membership_recovery_audit WHERE history_id=$1', [evidence.history.id]);
      assert.equal(audit.rows[0].count, '1');
    });
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
    if (running) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(dir, { recursive: true, force: true });
  }
});