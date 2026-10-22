#!/usr/bin/env node
// Offline review by default. --preflight is READ ONLY; no apply mode exists.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATIONS = [
  '202610200001_individual_voucher_credit.sql',
  '202610200002_membership_voucher_quotes.sql',
  '202610200003_membership_voucher_settlement.sql',
  '202610200004_booking_voucher_refunds.sql',
  '202610200005_voucher_member_monthly_snapshot.sql',
  '202610200006_program_voucher_purchase.sql',
  '202610200007_booking_credit_attempts.sql',
  '202610200008_program_member_entitlements.sql',
  '202610200009_program_voucher_accounting.sql',
  '202610200010_membership_voucher_monthly.sql',
  '202610200011_membership_checkout_provider_attempts.sql',
  '202610200012_membership_voucher_accounting_binding.sql',
  '202610200013_membership_fee_requote.sql',
  '202610200014_voucher_allocation_refunds.sql',
];
const TABLES = ['tenant','member','organization','voucher','voucher_transaction',
  'voucher_monthly_snapshot','system_settings','membership_fee_token','member_membership_history',
  'discount_code','discount_code_usage','program_ticket_transaction','training_fund_transaction',
  'booking','complex_event_booking','event','complex_event','complex_event_session','member_group_assignment',
  'membership_billing_agreements','organisation_membership_history'];
const SETTINGS_KEYS = ['individual_vouchers_enabled','organization_voucher_display_name','member_voucher_display_name',
  'xero_voucher_clearing_account_code','quickbooks_voucher_clearing_account_id',
  'xero_training_fund_clearing_account_code','quickbooks_training_fund_clearing_account_id',
  'xero_program_sales_account_code','quickbooks_program_sales_item_id',
  'xero_program_tax_code','quickbooks_program_tax_code','program_price_vat_rate_percent'];

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length > 1 || args.some(arg => arg !== '--preflight')) {
    throw new Error('Only offline review (no arguments) or --preflight is supported; application is intentionally unavailable.');
  }
  const migrations = await Promise.all(MIGRATIONS.map(async name => {
    const sql = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
    return { name, sha256: createHash('sha256').update(sql).digest('hex') };
  }));
  if (!args.includes('--preflight')) {
    const report = { mode: 'offline-review', writesPerformed: false, migrations };
    console.log(JSON.stringify(report));
    return report;
  }
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Provider CA unavailable');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid provider CA');
  const db = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
  try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL statement_timeout='20s'");
    const columns = (await db.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])
      ORDER BY table_name,ordinal_position`, [TABLES])).rows;
    const constraints = (await db.query(`SELECT c.relname AS table_name,k.conname,pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,k.conname`, [TABLES])).rows;
    const policies = (await db.query(`SELECT tablename,policyname,roles,cmd FROM pg_policies
      WHERE schemaname='public' AND tablename=ANY($1::text[])`, [TABLES])).rows;
    const presentNewTables = (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND tablename=ANY($1::text[])`, [['voucher_credit_purchase','voucher_credit_allocation','voucher_booking_refund',
      'voucher_booking_credit_share','voucher_allocation_refund','membership_fee_requote',
      'membership_voucher_quote','membership_voucher_settlement','program_credit_purchase']])).rows;
    const dependencies = (await db.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_function_result(p.oid) AS result,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND p.proname=ANY($1::text[])`, [['check_oneoff_ticket_capacity','check_complex_event_ticket_capacity',
      'claim_sales_allocation_invitation','sales_capacity_state']])).rows;
    // Only aggregate metadata is reported; no tenant identity or setting value.
    const settingDuplicates = (await db.query(`SELECT setting_key,count(*)::int AS duplicate_groups
      FROM (SELECT tenant_id,setting_key FROM public.system_settings WHERE setting_key=ANY($1::text[])
        GROUP BY tenant_id,setting_key HAVING count(*)>1) d GROUP BY setting_key`, [SETTINGS_KEYS])).rows;
    await db.query('ROLLBACK');
    const report = { mode: 'read-only-preflight', verifiedTarget: 'lvmzliemqnieeoruhkik',
      writesPerformed: false, migrations, columns, constraints, policies, presentNewTables, dependencies, settingDuplicates };
    console.log(JSON.stringify(report));
    return report;
  } finally {
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Voucher migration verification failed; check pinned destination credentials/TLS and arguments. No migration was applied.');
    process.exitCode = 1;
  });
}
