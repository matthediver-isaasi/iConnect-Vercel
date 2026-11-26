import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectManifest, deploymentManifest, followUpDeploymentManifest } from './event-funnel-recovery-readiness.mjs';
import { packageFunnelMigrations } from './package-event-funnel-migrations.mjs';

test('deployment identities are unique without changing source hashes or dependency order', async () => {
  const sources = await inspectManifest();
  const deployment = deploymentManifest(sources);
  const existing = await readdir(new URL('../supabase/migrations/', import.meta.url));
  assert.equal(deployment.length, 45);
  assert.equal(new Set(deployment.map(entry => entry.deploymentVersion)).size, 45);
  assert.deepEqual(deployment.map(entry => entry.file), sources.map(entry => entry.file));
  assert.deepEqual(deployment.map(entry => entry.sha256), sources.map(entry => entry.sha256));
  assert.deepEqual(deployment.map(entry => entry.deploymentVersion),
    deployment.map(entry => entry.deploymentVersion).sort());
  for (const entry of deployment) {
    assert.match(entry.deploymentVersion, /^\d{14}$/);
    assert.ok(!existing.some(name => name.startsWith(`${entry.deploymentVersion}_`)));
  }
});

test('unknown and duplicate source identities fail closed', () => {
  assert.throws(() => deploymentManifest([{file:'202701230046_event_funnel_future.sql'}]), /Unreviewed/);
  assert.throws(() => deploymentManifest([{file:'202701230001_unrelated.sql'}]), /Unreviewed/);
  const entry = {file:'202701230001_event_funnel_definitions.sql'};
  assert.throws(() => deploymentManifest([entry,entry]), /Duplicate/);
});

test('membership additions are packaged separately and cannot replay the installed base', async () => {
  const base = await inspectManifest();
  const membership = await inspectManifest(undefined, 'membership');
  assert.equal(base.length, 45);
  assert.equal(membership.length, 1);
  assert.ok(!base.some(entry => entry.file === membership[0].file));
  const deployment = followUpDeploymentManifest(membership, 'membership');
  assert.equal(deployment[0].deploymentVersion, '20270127120001');
  const activation = await inspectManifest(undefined, 'activation');
  assert.equal(activation.length, 1);
  assert.equal(followUpDeploymentManifest(activation, 'activation')[0].deploymentVersion, '20270204120001');
  assert.throws(() => followUpDeploymentManifest(base, 'membership'), /Unreviewed/);
  assert.throws(() => followUpDeploymentManifest(membership, 'unknown'), /Unreviewed/);
  await assert.rejects(inspectManifest(undefined, 'unknown'), /Unknown/);
  const root = await mkdtemp(path.join(tmpdir(), 'funnel-membership-package-'));
  try {
    const receipt = await packageFunnelMigrations(path.join(root, 'membership'), { release: 'membership' });
    assert.equal(receipt.release, 'membership');
    assert.equal(receipt.migrations.length, 1);
    assert.deepEqual(await readFile(path.join(root, 'membership', receipt.migrations[0].file)),
      await readFile(new URL(`../supabase/migrations/${membership[0].file}`, import.meta.url)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('offline package preserves SQL bytes, records identities and refuses overwrite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'funnel-package-test-'));
  try {
    const target = path.join(root, 'release');
    const receipt = await packageFunnelMigrations(target);
    assert.equal(receipt.migrations.length, 45);
    assert.deepEqual(JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8')), receipt);
    for (const entry of receipt.migrations) {
      const sql = await readFile(path.join(target, entry.file));
      const original = await readFile(new URL(`../supabase/migrations/${entry.sourceFile}`, import.meta.url));
      assert.deepEqual(sql, original);
      assert.equal(createHash('sha256').update(sql).digest('hex'), entry.sha256);
    }
    await assert.rejects(packageFunnelMigrations(target), { code: 'EEXIST' });
    await assert.rejects(packageFunnelMigrations(), /explicit new output/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
