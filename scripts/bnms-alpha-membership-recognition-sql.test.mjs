import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';
import { parseRecognitionArgs, verifyRecognitionSchema, normalizedRecognitionCatalog, safeRecognitionFailure } from './run-bnms-alpha-membership-recognition.mjs';

test('PG17 normalization accepts only postgres owner MAINTAIN, never client grants; errors redact arbitrary details', () => {
  const owner = { grantee: 'postgres', grantor: 'postgres', privilege: 'MAINTAIN', grantable: false };
  const client = { ...owner, grantee: 'service_role' };
  assert.deepEqual(normalizedRecognitionCatalog({ owner: 'postgres', acl: [owner, client] }).acl, [client]);
  assert.deepEqual(normalizedRecognitionCatalog({ owner: 'other', acl: [owner] }).acl, [owner]);
  assert.deepEqual(normalizedRecognitionCatalog({ owner: 'postgres', acl: [{ ...owner, grantable: true }] }).acl, [{ ...owner, grantable: true }]);
  const safe = safeRecognitionFailure({ message: 'secret connection string', recognitionStage: 'secret token', code: 'secret' });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(safeRecognitionFailure({ message: 'Recognition schema/security differs from reviewed catalog', recognitionStage: 'schema-verify', code: '42501' }).stage, 'schema-verify');
});

test('recognition runner requires exact review and rejects scope overrides', () => {
  const base = ['--manifest', '/tmp/manifest.json', '--out', 'exports/recognition.json'];
  assert.equal(parseRecognitionArgs(base).apply, undefined);
  assert.throws(() => parseRecognitionArgs([...base, '--apply']), /review hash/);
  assert.throws(() => parseRecognitionArgs([...base, '--member', 'other']), /forbidden/);
  assert.throws(() => parseRecognitionArgs([...base, '--from', '2020-01-01']), /forbidden/);
  assert.equal(parseRecognitionArgs([...base, '--apply', `--review-sha256=${'a'.repeat(64)}`]).apply, true);
});
test('recognition SQL enforces ownership, audit immutability, revocation and service-role read only', { timeout: 90000 }, async () => {
  const h = await createLocalPostgresHarness('membership-recognition-sql-');
  const run = (cmd, args, input) => {
    const result = spawnSync(cmd, args, { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const conn = ['-h', h.socket, '-p', String(h.port), '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'];
  const sql = input => run('psql', conn, input);
  const reject = (input, pattern) => {
    const r = spawnSync('psql', conn, { input, encoding: 'utf8' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, pattern);
  };
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
  let started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY, tenant_id uuid, member_id uuid, billing_agreement_id uuid, membership_renewal_date date);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY, tenant_id uuid, member_id uuid);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY, tenant_id uuid, member_id uuid);
      CREATE TABLE bnms_dd_alpha_adoption(id uuid PRIMARY KEY, tenant_id uuid, member_id uuid, history_id uuid, plan_id uuid, agreement_id uuid, manifest_sha256 text, UNIQUE(id,tenant_id,member_id));
      INSERT INTO member_membership_history VALUES('${id(3)}','${tenant}','${id(2)}','${id(4)}','2027-10-01');
      INSERT INTO membership_billing_agreements VALUES('${id(4)}','${tenant}','${id(2)}');
      INSERT INTO membership_payment_plans VALUES('${id(5)}','${tenant}','${id(2)}');
      INSERT INTO bnms_dd_alpha_adoption VALUES('${id(1)}','${tenant}','${id(2)}','${id(3)}','${id(5)}','${id(4)}','3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a');`);
    sql(readFileSync(new URL('../supabase/migrations/20261119_bnms_dd_alpha_membership_recognition.sql', import.meta.url), 'utf8'));
    const client = { query: async query => ({ rows: [{ catalog: JSON.parse(sql(query).trim()) }] }) };
    await verifyRecognitionSchema(client);
    for (const [tamper, restore] of [
      ['ALTER TABLE bnms_dd_alpha_membership_recognition DISABLE TRIGGER membership_recognition_guard;',
        'ALTER TABLE bnms_dd_alpha_membership_recognition ENABLE TRIGGER membership_recognition_guard;'],
      ['GRANT INSERT ON bnms_dd_alpha_membership_recognition TO service_role;',
        'REVOKE INSERT ON bnms_dd_alpha_membership_recognition FROM service_role;'],
      ['GRANT SELECT ON bnms_dd_alpha_membership_recognition TO authenticated;',
        'REVOKE SELECT ON bnms_dd_alpha_membership_recognition FROM authenticated;'],
      ['ALTER TABLE bnms_dd_alpha_membership_recognition DISABLE ROW LEVEL SECURITY;',
        'ALTER TABLE bnms_dd_alpha_membership_recognition ENABLE ROW LEVEL SECURITY;'],
      ['ALTER FUNCTION validate_membership_recognition() SECURITY DEFINER;',
        'ALTER FUNCTION validate_membership_recognition() SECURITY INVOKER;'],
    ]) {
      sql(tamper);
      await assert.rejects(verifyRecognitionSchema(client), /schema\/security differs/);
      sql(restore);
      await verifyRecognitionSchema(client);
    }
    const insert = `INSERT INTO bnms_dd_alpha_membership_recognition(adoption_id,tenant_id,member_id,history_id,agreement_id,plan_id,effective_from,effective_until,authorization_reference,review_sha256)
      VALUES('${id(1)}','${tenant}','${id(2)}','${id(3)}','${id(4)}','${id(5)}','2026-09-21','2027-10-01','user-approved','${'a'.repeat(64)}');`;
    reject(insert.replace(id(4), id(8)), /ownership mismatch/);
    reject(`SET ROLE service_role; ${insert}`, /permission denied/);
    sql(insert);
    assert.equal(sql('SET ROLE service_role; SELECT count(*) FROM bnms_dd_alpha_membership_recognition;').trim().split('\n').at(-1), '1');
    reject('SET ROLE authenticated; SELECT * FROM bnms_dd_alpha_membership_recognition;', /permission denied/);
    reject("UPDATE bnms_dd_alpha_membership_recognition SET effective_until='2099-01-01';", /immutable/);
    reject('DELETE FROM bnms_dd_alpha_membership_recognition;', /cannot be deleted/);
    sql('UPDATE bnms_dd_alpha_membership_recognition SET revoked_at=now();');
    reject('UPDATE bnms_dd_alpha_membership_recognition SET revoked_at=NULL;', /immutable/);
    assert.equal(sql("SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%alpha%' AND tgrelid='bnms_dd_alpha_membership_recognition'::regclass;").trim(), '0');
  } finally {
    if (started) run('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop']);
    await h.cleanup();
  }
});