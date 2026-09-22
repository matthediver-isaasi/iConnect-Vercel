import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyManifest, canonicalHash, deterministicId, parseArgs, rollback, validateManifest,
} from './bnms-non-dd-apply.mjs';
import { TENANT } from './audit-bnms-non-dd-pilot.mjs';

const sourceHash = 'a'.repeat(64);
const candidateHash = 'c'.repeat(64);
const member = '11111111-1111-4111-8111-111111111111';
function fixture(overrides = {}) {
  const row = {
    id: deterministicId(member), member_id: member, tenant_id: TENANT,
    membership_year: '2025/2026', term_end_date: '2026-09-29', term_start_date: null,
    status: 'active', payment_status: 'paid', config_id: null, tier_label: 'Overseas Full',
    final_cost: 125, total_with_vat: 125, currency: 'GBP', payment_method: 'upfront',
    billing_period: 'annual', accounting_provider: 'xero',
    accounting_invoice_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    accounting_invoice_number: 'INV-1', xero_invoice_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    xero_invoice_number: 'INV-1',
    notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill', version: 1,
      sourceHash: candidateHash, startDateAuthority: 'unknown_not_inferred',
      expiryAuthority: 'retained_legacy_expiry' }),
    ...overrides,
  };
  return { version: 1, tenantId: TENANT, asOf: '2026-09-22', sourceHash,
    rows: [row], evidence: [{ memberId: member, sourceHash: candidateHash }] };
}

test('validates the exact approved fixed-cycle contract', () => {
  const manifest = fixture();
  assert.equal(validateManifest(manifest), manifest);
  assert.match(manifest.rows[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(deterministicId(member), manifest.rows[0].id);
  assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 }));
});

test('rejects extraneous and forbidden future lifecycle fields', () => {
  for (const extra of ['term_key', 'billing_agreement_id', 'annual_renewal_state',
    'commitment_snapshot', 'membership_renewal_date']) {
    assert.throws(() => validateManifest(fixture({ [extra]: null })), /extraneous/i);
  }
  const top = fixture(); top.approved = true;
  assert.throws(() => validateManifest(top), /extraneous/i);
});

test('rejects drifted pins, expiry, identity, invoice and provenance', () => {
  assert.throws(() => validateManifest(fixture({ term_end_date: '2027-01-01' })), /fixed-cycle/i);
  assert.throws(() => validateManifest(fixture({ term_end_date: '2026-09-21' })), /fixed-cycle/i);
  assert.throws(() => validateManifest(fixture({ id: member })), /fixed-cycle/i);
  assert.throws(() => validateManifest(fixture({ xero_invoice_number: 'OTHER' })), /complete and equal/i);
  assert.throws(() => validateManifest(fixture({ notes: '{}' })), /provenance/i);
});

test('rejects duplicate members, ids, invoices and incomplete evidence', () => {
  const duplicate = fixture();
  duplicate.rows.push({ ...duplicate.rows[0] });
  duplicate.evidence.push({ ...duplicate.evidence[0] });
  assert.throws(() => validateManifest(duplicate), /Duplicate row\/member/i);
  const missing = fixture(); missing.evidence = [];
  assert.throws(() => validateManifest(missing), /cover every row/i);
});

test('CLI is dry-run by default and gates all write modes', () => {
  assert.deepEqual(parseArgs(['--manifest', '/tmp/m.json', '--out', '/tmp/r.json']),
    { apply: false, manifest: '/tmp/m.json', out: '/tmp/r.json' });
  assert.throws(() => parseArgs(['--manifest', '/tmp/m.json', '--out', '/tmp/r.json', '--apply']), /reviewed/i);
  assert.throws(() => parseArgs(['--manifest', '/tmp/m.json', '--out', './r.json']), /under \/tmp/i);
  assert.throws(() => parseArgs(['--manifest', '/tmp/m.json', '--out', '/tmp/r.json',
    '--rollback', '/tmp/old.json', '--apply', `--review-sha256=${'b'.repeat(64)}`]), /separate/i);
});

test('private report mode used by the runner is representable on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bnms-non-dd-test-'));
  const file = join(dir, 'report');
  const handle = await import('node:fs/promises').then(fs => fs.open(file, 'wx', 0o600));
  await handle.close();
  await chmod(file, 0o600);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

function operationFixture() {
  const raw = {
    id: member,
    preferences: {
      membership_status: 'Active', ym_membership_type: 'Full Membership Overseas',
      member_class: 'Overseas Full', ym_web_site_member_id: '123',
      ym_date_membership_expires: '29/09/2026',
    },
    duplicate_fields: false, dd_evidence: false, history_count: 0,
  };
  const candidate = { ...raw, category: 'requires_term_and_invoice_review', expiry: '2026-09-29' };
  const manifest = fixture();
  manifest.sourceHash = createHash('sha256').update(JSON.stringify([candidate])).digest('hex');
  const digest = createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
  manifest.evidence[0].sourceHash = digest;
  const notes = JSON.parse(manifest.rows[0].notes);
  notes.sourceHash = digest;
  manifest.rows[0].notes = JSON.stringify(notes);
  return { manifest, raw };
}
function fixtureClient({ manifest, raw, existing = [], downstream = [] }) {
  const calls = [];
  const inserted = { ...manifest.rows[0], final_cost: '125.00', total_with_vat: '125.00',
    term_end_date: new Date(`${manifest.rows[0].term_end_date}T00:00:00.000Z`),
    created_at: '2026-09-22T10:00:00.000Z' };
  return {
    calls, inserted,
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT id,slug FROM tenant')) return { rows: [{ id: TENANT, slug: 'bnms' }] };
      if (sql.startsWith('SELECT * FROM member_membership_history WHERE tenant_id')
          && sql.includes('member_id=ANY')) return { rows: existing };
      if (sql.startsWith('WITH prefs AS')) {
        return { rows: [{ ...raw, history_count: raw.history_count + (existing.length ? 1 : 0) }] };
      }
      if (sql.startsWith('SELECT id FROM member WHERE')) return { rows: [{ id: member }] };
      if (sql.includes('UNION ALL SELECT id FROM organisation_membership_history')) return { rows: [] };
      if (sql.startsWith('INSERT INTO member_membership_history')) return { rows: [inserted] };
      if (sql.startsWith('SELECT * FROM member_membership_history WHERE tenant_id')
          && sql.includes('ORDER BY id')) return { rows: [inserted] };
      if (sql.includes('SELECT history_id FROM bnms_dd_alpha_adoption')) return { rows: downstream };
      if (sql.startsWith('DELETE FROM member_membership_history')) return { rows: [{ id: inserted.id }] };
      return { rows: [] };
    },
  };
}

test('apply journals and fsync boundary precedes commit, with local transaction timeouts', async () => {
  const { manifest, raw } = operationFixture();
  const client = fixtureClient({ manifest, raw });
  const events = [];
  const result = await applyManifest(client, manifest, {
    apply: true, verifiedDestination: true, reviewSha256: canonicalHash(manifest),
    journal: async report => events.push(report),
  });
  assert.equal(result.committed, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].committed, false);
  assert.deepEqual(result.insertedIds, [manifest.rows[0].id]);
  assert.ok(client.calls.indexOf("SET LOCAL statement_timeout='120s'")
    < client.calls.findIndex(sql => sql === 'COMMIT'));
  assert.ok(client.calls.some(sql => sql.includes('bnms_dd_alpha_invoice_link')));
  assert.ok(client.calls.some(sql => sql.includes('bnms_dd_beta_invoice_link')));
});

test('exact replay is explicitly zero-write and does not require journal', async () => {
  const { manifest, raw } = operationFixture();
  const prior = { ...manifest.rows[0], final_cost: '125.00', total_with_vat: '125.00',
    term_end_date: new Date(`${manifest.rows[0].term_end_date}T00:00:00.000Z`) };
  const client = fixtureClient({ manifest, raw, existing: [prior] });
  const result = await applyManifest(client, manifest, {
    apply: true, verifiedDestination: true, reviewSha256: canonicalHash(manifest),
  });
  assert.equal(result.mode, 'replay');
  assert.equal(result.writes, 0);
  assert.ok(!client.calls.some(sql => sql.startsWith('INSERT INTO')));
});

test('rollback verifies manifest rows and refuses downstream references', async () => {
  const { manifest, raw } = operationFixture();
  const applied = fixtureClient({ manifest, raw });
  const report = { mode: 'apply', hash: canonicalHash(manifest),
    insertedRows: [applied.inserted] };
  const blocked = fixtureClient({ manifest, raw, downstream: [{ history_id: applied.inserted.id }] });
  await assert.rejects(rollback(blocked, manifest, report, {
    verifiedDestination: true, reviewSha256: canonicalHash(manifest),
  }), /Downstream references/);
  const client = fixtureClient({ manifest, raw });
  const result = await rollback(client, manifest, report, {
    verifiedDestination: true, reviewSha256: canonicalHash(manifest),
  });
  assert.equal(result.mode, 'rollback');
  assert.deepEqual(result.deletedIds, [manifest.rows[0].id]);
  const tampered = structuredClone(report);
  tampered.insertedRows[0].member_id = '22222222-2222-4222-8222-222222222222';
  await assert.rejects(rollback(fixtureClient({ manifest, raw }), manifest, tampered, {
    verifiedDestination: true, reviewSha256: canonicalHash(manifest),
  }), /manifest identities\/payload/);
});