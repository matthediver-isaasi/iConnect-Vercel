import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { main, MIGRATION, PREDECESSOR, REVIEWED_SHA256, reviewedSettingsRpcBodies, validateApplyArguments } from './apply-sales-quote-naming.mjs';

const ref = 'lvmzliemqnieeoruhkik';
const args = ['--apply', `--reviewed-sha256=${REVIEWED_SHA256}`, `--confirm-destination=${ref}`];
const env = {
  DEST_DATABASE_URL: `postgresql://postgres.${ref}:test@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,
  DEST_SUPABASE_URL: `https://${ref}.supabase.co`,
};

test('migration runner is offline by default and review does not need credentials', async () => {
  await main(['--review'], {});
  const run = spawnSync(process.execPath, ['scripts/apply-sales-quote-naming.mjs'], { env: {}, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /OFFLINE REVIEW ONLY/);
  assert.match(run.stdout, new RegExp(REVIEWED_SHA256));
});

test('apply requires exact review and destination, refusing fallbacks and insecure SSL', () => {
  assert.doesNotThrow(() => validateApplyArguments(args, env));
  for (const values of [[], ['--apply'], args.map((arg) => arg.replace(REVIEWED_SHA256, 'wrong')), [...args, '--force']]) {
    assert.throws(() => validateApplyArguments(values, env));
  }
  for (const bad of [
    {}, { DATABASE_URL: env.DEST_DATABASE_URL, SUPABASE_URL: env.DEST_SUPABASE_URL },
    { ...env, DEST_DATABASE_URL: 'postgresql://postgres:secret@localhost/postgres' },
    { ...env, DEST_DATABASE_URL: `${env.DEST_DATABASE_URL}?sslmode=no-verify` },
    { ...env, DEST_SUPABASE_URL: 'https://legacy.supabase.co' },
    { ...env, DEST_DATABASE_URL: env.DEST_DATABASE_URL.replace(ref, 'source') },
  ]) assert.throws(() => validateApplyArguments(args, bad));
});

test('reviewed RPC reconstruction preserves the visibility branches and every predecessor statement', async () => {
  const base = await readFile('supabase/migrations/202610120004_sales_automatic_quote_task_lists.sql', 'utf8');
  const visibility = await readFile(PREDECESSOR, 'utf8');
  const naming = await readFile(MIGRATION, 'utf8');
  const bodies = reviewedSettingsRpcBodies(base, visibility, naming);
  assert.match(bodies.predecessor, /catalogue_visibility_v1/);
  assert.doesNotMatch(bodies.predecessor, /quote_naming_v1/);
  assert.match(bodies.migrated, /quote_naming_v1/);
  for (const anchor of ['catalogue_visibility_v1', 'show_internal_code=CASE', 'show_sku=CASE',
    'FOR UPDATE', 'ON CONFLICT', '40001', 'sales_audit_event', 'quote_task_list_name=CASE']) {
    assert.ok(bodies.predecessor.includes(anchor), anchor);
    assert.ok(bodies.migrated.includes(anchor), anchor);
  }
  // Removing only the injected naming blocks recovers the latest predecessor,
  // proving we did not silently replace it with an older task-list function.
  const validation = naming.split('$validation$')[1].replace(/\s+/g, ' ').trim();
  const update = naming.split('$update$')[1].replace(/\s+/g, ' ').trim();
  assert.equal(bodies.migrated.replace(validation, 'INSERT INTO public.sales_settings(tenant_id)')
    .replace(update, 'UPDATE public.sales_settings SET'), bodies.predecessor);
});
