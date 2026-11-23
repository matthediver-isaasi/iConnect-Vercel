import test from 'node:test';
import assert from 'node:assert/strict';
import { stagingTarget } from './apply-migration-to-staging.mjs';

test('accepts only the staging project', () => {
  assert.equal(stagingTarget('postgresql://postgres.skaszwscycbfvfofnifx:x@aws-1-eu-central-1.pooler.supabase.com:5432/postgres').hostname,
    'aws-1-eu-central-1.pooler.supabase.com');
  assert.ok(stagingTarget('postgresql://postgres:x@db.skaszwscycbfvfofnifx.supabase.co:5432/postgres'));
});

test('refuses production and anything else', () => {
  for (const url of [
    'postgresql://postgres.lvmzliemqnieeoruhkik:x@aws-1-eu-central-1.pooler.supabase.com:5432/postgres',
    'postgresql://postgres:x@db.lvmzliemqnieeoruhkik.supabase.co:5432/postgres',
    'postgresql://postgres.skaszwscycbfvfofnifx:x@evil.example.com:5432/postgres',
    'postgresql://postgres.other:x@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?x=lvmzliemqnieeoruhkik',
  ]) assert.throws(() => stagingTarget(url));
  assert.throws(() => stagingTarget(''));
});
