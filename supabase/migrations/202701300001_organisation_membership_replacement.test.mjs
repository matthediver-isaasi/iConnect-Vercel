import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = uuid(1), ORG = uuid(2), ACTOR = uuid(3), ORIGINAL = uuid(10), ROLLING = uuid(11);

// Mirrors the live (DEST) uniqueness/overlap contract the migration rewrites.
const SCHEMA = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE EXTENSION btree_gist;
  CREATE TABLE organisation_membership_history(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, organization_id uuid NOT NULL,
    membership_year text, status text DEFAULT 'active', payment_status text DEFAULT 'unpaid', paid_at timestamptz,
    term_start_date date, term_end_date date, scheduled_activation_date date, annual_renewal_state text,
    membership_renewal_date date, term_duration_months int, term_anchor_date date, term_key text, previous_term_id uuid,
    config_id uuid, band_id uuid, tier_label text, field_value numeric, annual_cost numeric, prorata_cost numeric,
    free_period_discount numeric, rollover_discount numeric, custom_discount_total numeric, custom_discount_details jsonb,
    final_cost numeric, currency text, billing_period text, purchase_order_number text, vat_rate_percent numeric,
    vat_amount numeric, total_with_vat numeric, year_number int, prorata_days int, free_period_days_applied int,
    override_applied boolean, override_type text, notes text, xero_project_code text, billing_agreement_id uuid,
    accounting_invoice_id text, accounting_invoice_number text, xero_invoice_id text, xero_invoice_number text,
    cancelled_for_switch_at timestamptz);
  CREATE UNIQUE INDEX organisation_membership_history_org_year_uniq ON organisation_membership_history
    (tenant_id, organization_id, membership_year) WHERE ((term_key IS NULL) AND (cancelled_for_switch_at IS NULL));
  CREATE UNIQUE INDEX organisation_membership_history_rolling_term_uniq ON organisation_membership_history
    (tenant_id, organization_id, term_key) WHERE ((term_key IS NOT NULL) AND (cancelled_for_switch_at IS NULL));
  CREATE UNIQUE INDEX organisation_membership_history_rolling_successor_uniq ON organisation_membership_history
    (tenant_id, previous_term_id) WHERE ((previous_term_id IS NOT NULL) AND (cancelled_for_switch_at IS NULL));
  ALTER TABLE organisation_membership_history ADD CONSTRAINT organisation_membership_history_rolling_no_overlap
    EXCLUDE USING gist (tenant_id WITH =, organization_id WITH =, daterange(term_start_date, membership_renewal_date, '[)') WITH &&)
    WHERE ((term_key IS NOT NULL) AND (cancelled_for_switch_at IS NULL));
  GRANT SELECT, INSERT ON organisation_membership_history TO service_role;
  GRANT UPDATE (status, payment_status, final_cost, accounting_invoice_id) ON organisation_membership_history TO service_role;
`;

test('organisation membership replacement: atomic lineage, period lock, uniqueness and guards', { timeout: 60000 }, async () => {
  const h = await createLocalPostgresHarness('org-replacement-');
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
  let started = false, db;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(SCHEMA);
    await db.query(`INSERT INTO organisation_membership_history(id, tenant_id, organization_id, membership_year,
        term_start_date, term_end_date, final_cost, total_with_vat, currency, accounting_invoice_id, accounting_invoice_number, tier_label)
      VALUES ('${ORIGINAL}', '${T}', '${ORG}', '2026/27', '2026-04-01', '2027-03-31', 100, 120, 'GBP', 'INV-ID', 'INV-1', 'Small')`);
    const sql = await readFile(new URL('./202701300001_organisation_membership_replacement.sql', import.meta.url), 'utf8');
    await db.query(sql);
    // Idempotent re-application leaves the contract intact.
    await db.query(sql);

    const indexDef = (await db.query(`SELECT pg_get_indexdef('organisation_membership_history_org_year_uniq'::regclass) d`)).rows[0].d;
    assert.match(indexDef, /cancelled_for_switch_at IS NULL/);
    assert.match(indexDef, /status IS DISTINCT FROM 'replaced'/);

    // Live duplicates are still rejected.
    await assert.rejects(db.query(`INSERT INTO organisation_membership_history(tenant_id, organization_id, membership_year)
      VALUES ('${T}', '${ORG}', '2026/27')`), /duplicate key/);

    // Service-role cannot retire or forge lineage directly.
    await db.query('SET ROLE service_role');
    await assert.rejects(db.query(`UPDATE organisation_membership_history SET status='replaced' WHERE id='${ORIGINAL}'`),
      /Protected replacement application required/);
    await assert.rejects(db.query(`INSERT INTO organisation_membership_history(tenant_id, organization_id, membership_year, status)
      VALUES ('${T}', '${ORG}', '2030/31', 'replaced')`), /cannot be created as replaced/);
    await assert.rejects(db.query(`INSERT INTO organisation_membership_history(tenant_id, organization_id, membership_year, replaces_record_id)
      VALUES ('${T}', '${ORG}', '2031/32', '${ORIGINAL}')`), /Protected replacement application required/);
    await assert.rejects(db.query(`UPDATE organisation_membership_replacement SET reason='x'`), /permission denied/);
    await db.query('RESET ROLE');

    const apply = (payload, key = 'key-1', source = ORIGINAL) => db.query(
      `SELECT apply_organisation_membership_replacement($1,$2,$3,$4,$5,$6) r`,
      [T, source, ACTOR, 'Wrong tier', key, payload]);
    const history = { config_id: uuid(30), tier_label: 'Large', final_cost: 200, vat_amount: 40, total_with_vat: 240,
      currency: 'GBP', payment_status: 'unpaid', notes: 'replacement' };

    // Period changes and non-whitelisted fields are rejected.
    await assert.rejects(apply({ history, period: { membership_year: '2026/27', term_start_date: '2026-05-01', term_end_date: '2027-03-31' } }),
      /period cannot be changed/);
    await assert.rejects(apply({ history: { ...history, membership_year: '2027/28' } }), /not permitted/);
    await assert.rejects(apply({ history: { ...history, accounting_invoice_id: 'forged' } }), /not permitted/);

    const { rows: [{ r: first }] } = await db.query('SET ROLE service_role').then(() => apply({
      history, period: { membership_year: '2026/27', term_start_date: '2026-04-01', term_end_date: '2027-03-31' },
      original_total: 120, replacement_total: 240, accounting_provider: 'xero',
    }));
    await db.query('RESET ROLE');
    assert.equal(first.replayed, false);
    const rows = (await db.query(`SELECT * FROM organisation_membership_history WHERE organization_id='${ORG}' ORDER BY replaced_at NULLS LAST`)).rows;
    const original = rows.find(r => r.id === ORIGINAL), target = rows.find(r => r.id === first.target_record_id);
    assert.equal(original.status, 'replaced');
    assert.equal(original.replaced_by_record_id, target.id);
    assert.equal(original.accounting_invoice_id, 'INV-ID');
    assert.equal(target.replaces_record_id, ORIGINAL);
    assert.equal(target.membership_year, '2026/27');
    assert.equal(String(target.term_start_date.toISOString?.() ?? target.term_start_date).slice(0, 10), String(original.term_start_date.toISOString?.() ?? original.term_start_date).slice(0, 10));
    assert.equal(target.status, 'active');
    assert.equal(target.accounting_invoice_id, null);
    assert.equal(Number(target.final_cost), 200);

    // Replays return the same operation; another key cannot replace again.
    const { rows: [{ r: replay }] } = await apply({ history });
    assert.equal(replay.replayed, true);
    assert.equal(replay.target_record_id, first.target_record_id);
    await assert.rejects(apply({ history }, 'key-2'), /already been replaced/);

    // A replaced row cannot be reactivated, nor its period edited.
    await assert.rejects(db.query(`UPDATE organisation_membership_history SET status='active' WHERE id='${ORIGINAL}'`), /cannot be reactivated/);
    await assert.rejects(db.query(`UPDATE organisation_membership_history SET term_start_date='2026-05-01' WHERE id='${ORIGINAL}'`), /original period/);
    // Live uniqueness still applies to the replacement row.
    await assert.rejects(db.query(`INSERT INTO organisation_membership_history(tenant_id, organization_id, membership_year)
      VALUES ('${T}', '${ORG}', '2026/27')`), /duplicate key/);

    // Rolling commitment terms are not replaceable.
    await db.query(`INSERT INTO organisation_membership_history(id, tenant_id, organization_id, membership_year, term_key,
        term_start_date, term_end_date, membership_renewal_date) VALUES ('${ROLLING}', '${T}', '${uuid(4)}', 'r', 'rolling:2026-01-01',
        '2026-01-01', '2026-12-31', '2027-01-01')`);
    await assert.rejects(apply({ history }, 'key-rolling', ROLLING), /Rolling commitment terms cannot be replaced/);
  } finally {
    await db?.end().catch(() => {});
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', 'stop']);
    await h.cleanup?.();
  }
});
