import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./address-lookup.js', import.meta.url), 'utf8');
const migration = await readFile(
  new URL('../../supabase/migrations/20260903_ideal_postcodes_rate_limit.sql', import.meta.url),
  'utf8',
);
const migrationRunner = await readFile(
  new URL('../../scripts/apply-ideal-postcodes-rate-limit.mjs', import.meta.url),
  'utf8',
);

test('address lookup derives tenant and form context instead of trusting a tenant id', () => {
  assert.match(source, /resolveTenantFromRequest\(req\)/);
  assert.match(source, /getTenantContext\(req\)/);
  assert.match(source, /\.eq\('tenant_id', tenantId\)/);
  assert.match(source, /resolveFormAccess\(\{ supabase: db, req, tenantId, policy: form\.access_policy \}\)/);
  assert.doesNotMatch(source, /req\.body\?\.tenant_id|req\.query\?\.tenant_id/);
  assert.match(source, /field\?\.type === 'address_lookup'/);
  assert.match(source, /String\(field\?\.id\) === fieldId/);
  assert.match(source, /hasAuthCredentials\(req\) \? await getTenantContext\(req\) : null/);
});

test('address lookup rejects missing platform configuration and disabled tenants', () => {
  assert.match(source, /!process\.env\.IDEAL_POSTCODES_API_KEY/);
  assert.match(source, /code: 'ADDRESS_LOOKUP_UNAVAILABLE'/);
  assert.match(source, /\.eq\('integration_type', 'ideal_postcodes'\)/);
  assert.match(source, /if \(!integration\?\.is_enabled\)/);
  assert.match(source, /code: 'ADDRESS_LOOKUP_DISABLED'/);
});

test('address lookup passes the secret only to the fixed provider helper and returns normalized data', () => {
  assert.match(source, /lookupIdealPostcodes\(postcode, process\.env\.IDEAL_POSTCODES_API_KEY\)/);
  assert.match(source, /return respondJson\(200, \{ addresses \}, 'success'\)/);
  assert.doesNotMatch(source, /json\([^)]*IDEAL_POSTCODES_API_KEY/);
  assert.doesNotMatch(source, /return res\.[\s\S]{0,80}(?:error\?\.stack|error\?\.response|error\?\.url)/);
});

test('address lookup consumes a durable tenant, form, and client rate limit before provider access', () => {
  assert.match(source, /consume_address_lookup_rate_limit/);
  assert.match(source, /p_tenant_id: tenantId/);
  assert.match(source, /p_form_id: form\.id/);
  assert.match(source, /p_client_key: trustedClientAddress\(req\)/);
  assert.match(source, /respondJson\(429/);
  assert.ok(
    source.indexOf('consume_address_lookup_rate_limit') < source.indexOf('lookupIdealPostcodes(postcode'),
    'rate limit must be consumed before the billable provider call',
  );
  assert.match(source, /req\.headers\['x-vercel-forwarded-for'\]/);
  assert.doesNotMatch(source, /req\.headers\['x-forwarded-for'\]|req\.headers\['x-real-ip'\]/);
});

test('independent access and integration checks run together before rate limiting', () => {
  assert.match(source, /Promise\.all\(\[/);
  assert.ok(
    source.indexOf('Promise.all([') < source.indexOf('consume_address_lookup_rate_limit'),
    'access and integration checks must complete before rate limiting',
  );
  assert.ok(
    source.indexOf('consume_address_lookup_rate_limit') < source.indexOf('lookupIdealPostcodes(postcode'),
    'provider access must remain behind the durable rate limit',
  );
});

test('privacy-safe stage timing excludes request and address values', () => {
  assert.match(source, /\[Address lookup timing\]/);
  assert.match(source, /Server-Timing/);
  assert.match(source, /timings\.provider/);
  assert.match(source, /timings\.rateLimit/);
  const timingLog = source.match(/console\.info\('\[Address lookup timing\]'[^\n]+/)?.[0] || '';
  assert.match(timingLog, /\.\.\.timings, totalMs, outcome/);
  assert.doesNotMatch(timingLog, /postcode|client_key|formId|tenantId/i);
  assert.match(source, /respondJson\(429,[\s\S]*'rate_limited'\)/);
  assert.match(source, /reportTimings\('access_denied'\)/);
  assert.match(source, /respondJson\(403,[\s\S]*'integration_disabled'\)/);
  assert.match(source, /respondJson\(200, \{ addresses \}, 'success'\)/);
  assert.match(source, /respondJson\(502,[\s\S]*'unavailable'\)/);
});

test('durable lookup rate limit is atomic, hashed, and service-role only', () => {
  assert.match(migration, /PRIMARY KEY \(tenant_id, form_id, client_key_hash\)/);
  assert.match(migration, /ON CONFLICT \(tenant_id, form_id, client_key_hash\) DO UPDATE/);
  assert.match(migration, /extensions\.digest\(coalesce\(p_client_key, 'unknown'\), 'sha256'\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/);
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/);
});

test('rate-limit migration runner is destination-bound and verifies before commit', () => {
  assert.match(migrationRunner, /DEST_DATABASE_URL/);
  assert.match(migrationRunner, /DEST_SUPABASE_URL/);
  assert.match(migrationRunner, /isApprovedDestinationSupabaseTarget/);
  assert.match(migrationRunner, /row_security_enabled/);
  assert.ok(
    migrationRunner.indexOf("client.query('COMMIT')") > migrationRunner.indexOf('schema verification failed'),
    'schema verification must happen before commit',
  );
});