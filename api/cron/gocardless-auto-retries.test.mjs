import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('automatic retry sweep is fail-closed, bounded, deterministic, and auditable', async () => {
  const source = await readFile(new URL('./gocardless-auto-retries.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!cronSecret \|\| req\.headers\.authorization !== `Bearer \$\{cronSecret\}`\)/);
  assert.match(source, /const MAX_ROWS = 100/);
  assert.match(source, /const MAX_RUNTIME_MS = 45_000/);
  assert.match(source, /\.order\('auto_retry_next_at', \{ ascending: true \}\)/);
  assert.match(source, /\.order\('id', \{ ascending: true \}\)/);
  assert.match(source, /\.limit\(MAX_ROWS\)/);
  assert.match(source, /retryPaymentSafely/);
  assert.match(source, /task_name: 'gocardless_auto_retries'/);
  assert.match(source, /scheduled_task_log/);
});

test('Vercel registers the automatic retry sweep every fifteen minutes', async () => {
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const cron = config.crons.find((item) => item.path === '/api/cron/gocardless-auto-retries');
  assert.deepEqual(cron, {
    path: '/api/cron/gocardless-auto-retries',
    schedule: '*/15 * * * *',
  });
});