import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('GoCardless card exposes guarded discovery control, confirmation, summary and incomplete error', async () => {
  const source = await readFile(new URL('./AdminIntegrations.jsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="button-sync-gocardless-mandates"/);
  assert.match(source, /disabled=\{!gcEnabled \|\| !hasGcCredentials \|\| gcDiscoveryLoading/);
  assert.match(source, /Sync existing GoCardless mandates\?/);
  assert.match(source, /will not create plans, subscriptions, billing agreements, or membership records/);
  assert.match(source, /data-testid="gocardless-discovery-summary"/);
  assert.match(source, /data-testid="gocardless-discovery-error"/);
  assert.match(source, /matched_count/);
  assert.match(source, /ambiguous_count/);
  assert.match(source, /failed_count/);
});