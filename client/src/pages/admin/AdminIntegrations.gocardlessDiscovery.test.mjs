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

test('GoCardless card exposes validated automatic retry policy controls and counting guidance', async () => {
  const source = await readFile(new URL('./AdminIntegrations.jsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="gocardless-auto-retry-settings"/);
  assert.match(source, /data-testid="switch-gocardless-auto-retries"/);
  assert.match(source, /data-testid="input-gocardless-auto-retry-interval"/);
  assert.match(source, /min="1"[\s\S]*max="30"[\s\S]*step="1"/);
  assert.match(source, /data-testid="input-gocardless-auto-retry-max"/);
  assert.match(source, /min="0"[\s\S]*max="10"[\s\S]*step="1"/);
  assert.match(source, /after the original failed collection/);
  assert.match(source, /manual retries are not included/i);
  assert.match(source, /never requests a[\s\S]*retry at or after[\s\S]*grace deadline/i);
  assert.match(source, /auto_retry_policy/);
});