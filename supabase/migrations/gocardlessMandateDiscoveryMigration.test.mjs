import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('mandate discovery staging is private, tenant-bound, deduplicated, and isolated from billing tables', async () => {
  const sql = await readFile(new URL('./20260916_gocardless_mandate_discovery.sql', import.meta.url), 'utf8');
  assert.match(sql, /UNIQUE \(batch_id, gocardless_mandate_id\)/);
  assert.match(sql, /FOREIGN KEY \(batch_id, tenant_id\)[\s\S]*REFERENCES public\.gocardless_mandate_discovery_batch\(id, tenant_id\)/);
  assert.match(sql, /FOREIGN KEY \(matched_member_id, tenant_id\)[\s\S]*REFERENCES public\.member\(id, tenant_id\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated/g);
  assert.doesNotMatch(sql, /REFERENCES public\.(gocardless_customers|gocardless_mandates|membership_billing_agreements|membership_payment_plans|member_membership_history)/);
});