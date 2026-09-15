import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { destinationConfig, durableFile } from './bnms-youtube-categorisation-io.mjs';

const rest = 'https://lvmzliemqnieeoruhkik.supabase.co';
const db = 'postgresql://postgres.lvmzliemqnieeoruhkik:synthetic@aws-0-eu-west-2.pooler.supabase.com:5432/postgres';

test('destination pins reject clones, legacy endpoints and TLS overrides', () => {
  assert.equal(destinationConfig(rest, db).connectionString, db);
  for (const wrong of [undefined, db.replace('lvmzliemqnieeoruhkik', 'wrong'),
    db.replace('pooler.supabase.com', 'attacker.example'), `${db}?sslmode=no-verify`]) {
    assert.throws(() => destinationConfig(rest, wrong));
  }
  assert.throws(() => destinationConfig('https://legacy.supabase.co', db));
});

test('audit files preserve unicode bytes and cannot overwrite prior evidence', () => {
  const dir = mkdtempSync(`${tmpdir()}/bnms-audit-`);
  const path = `${dir}/audit.json`;
  try {
    durableFile(path, '{"value":"Physics – café"}');
    assert.equal(readFileSync(path, 'utf8'), '{"value":"Physics – café"}');
    assert.throws(() => durableFile(path, 'overwrite'), /EEXIST/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('original validator rejects live mode before accessing credentials or data', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-bnms-youtube-categorisation.mjs', '--apply'],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Only --dry-run is accepted/);
});