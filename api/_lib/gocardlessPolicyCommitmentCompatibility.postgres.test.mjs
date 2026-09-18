import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { buildAgreementSnapshot, resolveDdOffer } from './gocardlessDirectDebit.js';

// Explicitly opt in to a disposable, socket-only PostgreSQL cluster. Never
// read DATABASE_URL or contact an app, provider, email service or remote DB.
test('DD policy compatibility through deployed commitment and form SQL', { timeout: 120000 }, async (t) => {
  assert.equal(process.env.TEST_ISOLATION_ACTIVE, '1', 'Run through scripts/run-isolated-tests.mjs');
  assert.equal(process.env.TEST_ISOLATION_ALLOW_LOCAL_PG, '1', 'Require --allow-local-postgres');
  const dir = await mkdtemp(join(tmpdir(), 'dd-policy-compat-pg-'));
  const cluster = join(dir, 'data');
  let running = false;
  let db;
  let sequence = 100;
  const uuid = () => `00000000-0000-0000-0000-${String(++sequence).padStart(12, '0')}`;
  const tenant = uuid();
  const otherTenant = uuid();
  const insert = async (table, values) => {
    const columns = Object.keys(values);
    const result = await db.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      Object.values(values),
    );
    return result.rows[0];
  };
  const migrate = async (name) => {
    await db.query(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  };
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(dir, 'postgres.log'), '-o', `-k ${dir} -p 55489 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    db = new pg.Client({ host: dir, port: 55489, user: 'runner', database: 'postgres' });
    await db.connect();
    // Minimal prerequisite schema, matching the existing rolling PostgreSQL
    // fixtures. Every commitment/form/policy guard below is the actual migration,
    // never a test reimplementation or a disabled trigger.
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant (id uuid PRIMARY KEY);
      CREATE TABLE member (id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE organization (id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE membership_tier_config (
        id uuid PRIMARY KEY, tenant_id uuid, start_mode text, structure_scope_type text,
        dd_invoicing_mode text, dd_enabled boolean, currency text, is_active boolean,
        effective_from date, effective_to date
      );
      CREATE TABLE membership_billing_agreements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, member_id uuid, organization_id uuid,
        agreement_type text DEFAULT 'member', provider text, metadata jsonb, status text DEFAULT 'active',
        idempotency_key text UNIQUE, environment text,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE member_membership_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, member_id uuid,
        membership_year text, config_id uuid, band_id uuid, tier_label text, field_value text, notes text,
        annual_cost numeric, final_cost numeric, currency text, vat_amount numeric,
        total_with_vat numeric, vat_rate_percent numeric, billing_period text, payment_method text,
        billing_agreement_id uuid, stripe_payment_intent_id text,
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
      CREATE TABLE form_submission (
        id uuid PRIMARY KEY, tenant_id uuid, payment_status text, payment_provider text,
        payment_meta jsonb, submitted_by_email text
      );
      CREATE TABLE membership_payment_plans (
        id uuid PRIMARY KEY, tenant_id uuid, billing_agreement_id uuid, status text,
        metadata jsonb, member_id uuid, organization_id uuid,
        gocardless_mandate_id text, gocardless_subscription_id text,
        amount_minor integer, currency text, next_charge_date date, updated_at timestamptz
      );
      CREATE TABLE membership_dd_renewals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, member_id uuid NOT NULL,
        previous_agreement_id uuid, renewal_year text
      );
    `);
    await insert('tenant', { id: tenant });
    await insert('tenant', { id: otherTenant });
    for (const name of [
      '20260919_form_membership_payment_quote.sql',
      '20260920_rolling_membership_commitments.sql',
      '20260921_rolling_membership_recovery.sql',
      '20261016_form_monthly_direct_debit_lifecycle.sql',
      '20260924_gocardless_org_renewal_owners.sql',
      '20261108_direct_debit_dated_commitments.sql',
      '20261108_explicit_direct_debit_collection_policy.sql',
    ]) await migrate(name);

    const fixture = async (mode, pricing, organization = false) => {
      const owner = uuid();
      await insert(organization ? 'organization' : 'member', { id: owner, tenant_id: tenant });
      const config = {
        id: uuid(), tenant_id: tenant, start_mode: mode, structure_scope_type: organization ? 'organization' : 'member',
        dd_enabled: true, dd_invoicing_mode: 'per_instalment', currency: 'GBP', is_active: true,
        billing_period: 'annual', pricing_model: 'flat', dd_monthly_amount: 12,
        dd_instalment_count: 12, dd_policy_version: 1,
        dd_collection_end_policy: 'continue', dd_pricing_policy: pricing,
      };
      await insert('membership_tier_config', {
        id: config.id, tenant_id: tenant, start_mode: mode, structure_scope_type: config.structure_scope_type,
        dd_enabled: true, dd_invoicing_mode: 'per_instalment', currency: 'GBP', is_active: true,
        dd_policy_version: 1, dd_collection_end_policy: 'continue', dd_pricing_policy: pricing,
      });
      const snapshot = (year = 2026, previousTerm = null) => {
        const sim = {
          success: true, config, annualCost: 120, finalCost: 120, totalWithVat: 144,
          vatAmount: 24, vatRatePercent: 20, currency: 'GBP', previousTerm,
          membershipYear: {
            label: mode === 'immediate' ? `rolling:${year}-09-18` : `${year}/${year + 1}`,
            start: `${year}-09-18`, end: `${year + 1}-09-17`,
          },
        };
        return buildAgreementSnapshot({ offer: resolveDdOffer(sim), simResult: sim, acceptedAt: `${year}-09-18T00:00:00Z` });
      };
      const ownerColumn = organization ? 'organization_id' : 'member_id';
      const historyTable = organization ? 'organisation_membership_history' : 'member_membership_history';
      const agreement = async (saved, overrides = {}) => insert('membership_billing_agreements', {
        ...saved.commitment, id: uuid(), tenant_id: tenant, [ownerColumn]: owner,
        agreement_type: organization ? 'organization' : 'member', provider: 'gocardless',
        metadata: { dd: saved, commitment: saved.commitment }, ...overrides,
      });
      const history = async (saved, agreementRow) => insert(historyTable, {
        ...saved.commitment, id: uuid(), tenant_id: tenant, [ownerColumn]: owner,
        membership_year: saved.membership_year, config_id: config.id, currency: saved.currency,
        annual_cost: saved.annual_cost, final_cost: saved.final_cost, vat_amount: saved.vat_amount,
        total_with_vat: saved.total_with_vat, billing_period: saved.kind, payment_method: 'direct_debit',
        billing_agreement_id: agreementRow.id,
      });
      return { owner, config, snapshot, ownerColumn, historyTable, agreement, history };
    };

    for (const mode of ['fixed_date', 'immediate']) {
      for (const pricing of ['fixed', 'dynamic']) {
        for (const organization of [false, true]) {
          await t.test(`${mode}/${pricing}/${organization ? 'organisation' : 'member'}: persisted terms and exact-boundary predecessor`, async () => {
            const f = await fixture(mode, pricing, organization);
            const saved = f.snapshot();
            const a = await f.agreement(saved);
            const h = await f.history(saved, a);
            assert.equal(h.term_key, `${mode === 'fixed_date' ? 'fixed' : 'rolling'}:2026-09-18`);
            assert.equal(h.membership_year, saved.membership_year);
            assert.equal(h.final_cost, pricing === 'dynamic' ? null : '120');
            assert.equal(h.vat_amount, pricing === 'dynamic' ? null : '24');
            assert.equal(h.total_with_vat, pricing === 'dynamic' ? null : '144');
            assert.deepEqual(a.commitment_snapshot.collection_policy, saved.collection_policy);
            await assert.rejects(() => db.query(
              `UPDATE membership_billing_agreements SET metadata=jsonb_set(metadata,'{dd,collection_policy,end_policy}','"stop"') WHERE id=$1`, [a.id],
            ), /immutable|commitment/i);
            await assert.rejects(() => db.query(
              `UPDATE ${f.historyTable} SET commitment_snapshot=jsonb_set(commitment_snapshot,'{collection_policy,pricing_policy}','"other"') WHERE id=$1`, [h.id],
            ), /immutable|commitment/i);
            const successor = f.snapshot(2027, { ...saved.commitment, id: h.id });
            const next = await f.agreement(successor);
            const nextHistory = await f.history(successor, next);
            assert.equal(nextHistory.previous_term_id, h.id);
            assert.equal(nextHistory.membership_year, successor.membership_year);
          });
        }
        await t.test(`${mode}/${pricing}: applicant form binding keeps committed net/VAT/null amounts and is idempotent`, async () => {
          const f = await fixture(mode, pricing);
          const saved = f.snapshot();
          const submission = uuid();
          await insert('form_submission', { id: submission, tenant_id: tenant, payment_status: 'setup_complete', payment_provider: 'gocardless_monthly_dd' });
          const a = await f.agreement(saved, {
            member_id: null,
            metadata: { dd: saved, commitment: saved.commitment, form_submission_id: submission },
          });
          const args = [a.id, submission, f.owner, { final_cost: 999999, collection_policy: { end_policy: 'stop' } }];
          const sql = 'SELECT bind_form_monthly_direct_debit_membership($1,$2,$3,$4) AS result';
          const bound = (await db.query(sql, args)).rows[0].result;
          assert.equal(bound.ok, true, JSON.stringify(bound));
          const h = (await db.query('SELECT * FROM member_membership_history WHERE id=$1', [bound.history_id])).rows[0];
          assert.equal(h.membership_year, saved.membership_year);
          assert.equal(h.term_key, saved.commitment.term_key);
          assert.equal(h.final_cost, pricing === 'dynamic' ? null : '120');
          assert.equal(h.vat_amount, pricing === 'dynamic' ? null : '24');
          assert.equal(h.total_with_vat, pricing === 'dynamic' ? null : '144');
          assert.deepEqual(h.commitment_snapshot.collection_policy, saved.collection_policy);
          assert.equal((await db.query(sql, args)).rows[0].result.idempotent, true);
        });
      }
    }

    await t.test('organisation tenant/scope and predecessor guards remain enforced', async () => {
      const f = await fixture('fixed_date', 'dynamic', true);
      const outsider = uuid();
      await insert('organization', { id: outsider, tenant_id: otherTenant });
      await assert.rejects(() => f.agreement(f.snapshot(), { organization_id: outsider }), /tenant/i);
      await assert.rejects(() => f.agreement(f.snapshot(), { tenant_id: otherTenant }), /tenant|scope/i);
      const original = f.snapshot();
      const a = await f.agreement(original);
      const h = await f.history(original, a);
      const differentOwner = await fixture('fixed_date', 'dynamic', true);
      const invalid = differentOwner.snapshot(2027, { ...original.commitment, id: h.id });
      const reserved = await differentOwner.agreement(invalid);
      await assert.rejects(() => differentOwner.history(invalid, reserved), /predecessor|previous/i);
      const row = await insert('membership_dd_renewals', { tenant_id: tenant, organization_id: f.owner, renewal_year: '2027/2028' });
      assert.equal(row.member_id, null);
      await assert.rejects(() => insert('membership_dd_renewals', { tenant_id: tenant, organization_id: f.owner, member_id: uuid() }), /one_owner/);
      await assert.rejects(() => insert('membership_dd_renewals', { tenant_id: tenant }), /one_owner/);
    });

    await t.test('fixed null totals and forged dynamic invoicing do not weaken old price guards', async () => {
      const fixed = await fixture('fixed_date', 'fixed');
      const bad = fixed.snapshot();
      bad.commitment.commitment_snapshot.amounts.final_cost = null;
      await assert.rejects(() => fixed.agreement(bad), /committed amount|total/i);
      const dynamic = await fixture('immediate', 'dynamic');
      const wrongInvoice = dynamic.snapshot();
      wrongInvoice.invoicing_mode = 'annual';
      await assert.rejects(() => dynamic.agreement(wrongInvoice), /invoicing|consent/i);
      const fabricated = dynamic.snapshot();
      fabricated.commitment.commitment_snapshot.amounts.total_with_vat = 0;
      await assert.rejects(() => dynamic.agreement(fabricated), /unknown|fabricated/i);
    });

    await t.test('legacy fixed consent is not restamped or newly authorised by migration replay', async () => {
      const f = await fixture('fixed_date', 'fixed');
      const dd = { kind: 'monthly_direct_debit', config_id: f.config.id, auto_renew: true, monthly_amount: 10.66, instalment_count: 12 };
      const legacy = await insert('membership_billing_agreements', {
        id: uuid(), tenant_id: tenant, member_id: f.owner, provider: 'gocardless', metadata: { dd },
      });
      await migrate('20260924_gocardless_org_renewal_owners.sql');
      await migrate('20261108_direct_debit_dated_commitments.sql');
      await migrate('20261108_explicit_direct_debit_collection_policy.sql');
      assert.deepEqual((await db.query('SELECT metadata FROM membership_billing_agreements WHERE id=$1', [legacy.id])).rows[0].metadata.dd, dd);
      await assert.rejects(() => db.query(
        `UPDATE membership_billing_agreements SET metadata=jsonb_set(metadata,'{dd,collection_policy}',$2) WHERE id=$1`,
        [legacy.id, { version: 1, pricing_policy: 'dynamic', end_policy: 'continue' }],
      ), /immutable/i);
    });
  } finally {
    if (db) await db.end().catch(() => {});
    if (running) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(dir, { recursive: true, force: true });
  }
});