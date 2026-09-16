import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repairDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(repairDir, '..', '..', '..');

test('production-only repair manifest is ordered, unique, and outside migrations', async () => {
  const manifest = JSON.parse(await readFile(path.join(repairDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.productionOnly, true);
  assert.equal(manifest.ordered, true);
  assert.deepEqual(manifest.files, [...manifest.files].sort((a, b) => a.localeCompare(b)));
  assert.equal(new Set(manifest.files).size, manifest.files.length);
  assert.deepEqual(manifest.files, [
    '001-publish.sql',
    '002-canvas.sql',
    '003-microsite-fence.sql',
  ]);

  const repairSql = new Set(
    (await readdir(repairDir)).filter((file) => file.endsWith('.sql')),
  );
  assert.deepEqual(repairSql, new Set(manifest.files));

  const normalMigrationFiles = await readdir(path.join(repoRoot, 'supabase', 'migrations'));
  assert.equal(
    normalMigrationFiles.some((file) => file.includes('member_content_repair')),
    false,
    'production-only member-content repair SQL must not enter the normal migration chain',
  );
});

test('targeted runner consumes the explicit production-only manifest', async () => {
  const runner = await readFile(
    path.join(repoRoot, 'scripts', 'apply-member-content-repair.mjs'),
    'utf8',
  );
  assert.match(runner, /scripts['"]\s*,\s*['"]sql['"]\s*,\s*['"]member-content-repair/);
  assert.match(runner, /manifest\.json/);
  assert.doesNotMatch(runner, /supabase\/migrations\/.*member_content_repair/);
  assert.match(runner, /const APPLY = process\.argv\.slice\(2\)\.includes\(['"]--apply['"]\)/);
  assert.match(runner, /if \(!APPLY\)/);
  assert.match(runner, /BEGIN READ ONLY/);
});