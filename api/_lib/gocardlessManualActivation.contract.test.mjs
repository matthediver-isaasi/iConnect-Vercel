import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('manual activation route is tenant-scoped, terminal-safe, and audited', async () => {
  const [source, migration] = await Promise.all([
    readFile(new URL('../admin/gocardless-dd.js', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/20260902_atomic_manual_dd_activation.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /loadPlanForAction\(tenantId, planId, res\)/);
  assert.match(source, /\.eq\('id', planId\)[\s\S]{0,120}\.eq\('tenant_id', tenantId\)/);
  assert.match(source, /action === 'manual_activate'/);
  assert.match(source, /\.rpc\('approve_manual_dd_membership_activation'/);
  assert.match(migration, /FROM membership_payment_plans[\s\S]*tenant_id = p_tenant_id[\s\S]*FOR UPDATE/);
  assert.match(migration, /FROM membership_billing_agreements[\s\S]*tenant_id = p_tenant_id[\s\S]*FOR UPDATE/);
  assert.match(migration, /status IN \('payment_plan_cancelled', 'expired', 'cancelled', 'completed'\)/);
  assert.match(migration, /FROM member_membership_history[\s\S]*tenant_id = p_tenant_id[\s\S]*FOR UPDATE/);
  assert.match(migration, /v_history_status IS DISTINCT FROM 'pending_activation'/);
  assert.match(migration, /UPDATE member_membership_history[\s\S]*tenant_id = p_tenant_id[\s\S]*status = 'pending_activation'/);
  assert.match(migration, /INSERT INTO membership_dd_admin_actions/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.approve_manual_dd_membership_activation/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.approve_manual_dd_membership_activation[\s\S]*TO service_role/);
});

test('manual activation is visible and actionable in the Direct Debit console', async () => {
  const source = await readFile(new URL('../../client/src/pages/DirectDebitAdmin.jsx', import.meta.url), 'utf8');
  assert.match(source, /pending_activation/);
  assert.match(source, /data-testid="alert-pending-membership-activation"/);
  assert.match(source, /manual_activate: \{ label: "Activate membership"/);
  assert.match(source, /data-testid="stat-pending-activations"/);
});

test('membership schedule controls expose accessible contextual help', async () => {
  const source = await readFile(new URL('../../client/src/pages/MembershipTierManagement.jsx', import.meta.url), 'utf8');
  assert.match(source, /aria-label=\{`About \$\{label\}`\}/);
  assert.match(source, /testId="help-dd-grace-days"/);
  assert.match(source, /It is not the delay between automatic retry attempts/);
  assert.match(source, /href="\/admin\/integrations"/);
  assert.match(source, /testId="help-dd-first-collection"/);
  assert.match(source, /testId="help-dd-activation-rule"/);
});