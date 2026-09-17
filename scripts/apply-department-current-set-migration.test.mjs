import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile(new URL('./apply-department-current-set-migration.mjs', import.meta.url), 'utf8');

test('migration runner is pinned, SHA-reviewed, and uses verified TLS', () => {
  assert.match(script, /--review-sha256/);
  assert.match(script, /Reviewed migration SHA-256 is missing/);
  assert.match(script, /lvmzliemqnieeoruhkik\.supabase\.co/);
  assert.match(script, /aws-1-eu-central-1\.pooler\.supabase\.com/);
  assert.match(script, /rejectUnauthorized: true/);
  assert.match(script, /BEGIN/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /20261101_department_current_set\.sql/);
  assert.match(script, /20261102_department_current_set_auth\.sql/);
  assert.match(script, /for \(const migration of migrations\) await client\.query\(migration\.sql\)/);
});