import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./apply-event-card-click-tracking.mjs', import.meta.url), 'utf8');

test('event click migration runner is destination-bound and verifies before commit', () => {
  assert.match(source, /DEST_DATABASE_URL/);
  assert.match(source, /DEST_SUPABASE_URL/);
  assert.match(source, /isApprovedDestinationSupabaseTarget/);
  assert.match(source, /simple_rls/);
  assert.match(source, /complex_force_rls/);
  assert.ok(
    source.indexOf("client.query('COMMIT')") > source.indexOf('schema verification failed'),
    'schema verification must happen before commit',
  );
});