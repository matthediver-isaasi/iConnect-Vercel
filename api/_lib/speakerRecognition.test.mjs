import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { issueSpeakerCertificate, speakerCertificateValues, speakerCertificateFields } from './speakerRecognition.js';
import { normalizeSpeakerAwardConfig, resolveSpeakerAward } from './speakerAwards.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const doc = await PDFDocument.create();
  doc.addPage([600, 400]);
  const source = Buffer.from(await doc.save());
  const artifacts = new Map();
  const writes = [];
  const completions = [];
  const row = { id: 'recognition', tenant_id: 'tenant', status: 'active', certificate_status: 'pending',
    certificate_template_id: 'template', snapshot: {
      speaker_name: 'External speaker', event_title: 'Conference', event_start_date: '2026-10-01T12:00:00Z',
      event_end_date: '2026-10-01T18:00:00Z',
      template: { id: 'template', tenant_id: 'tenant', status: 'active', source_bucket: 'private-uploads',
        source_path: 'tenant/source.pdf', source_sha256: hash(source) },
      placeholders: [{ placeholder_key: 'member.full_name', page_number: 1, x: 10, y: 10, width: 500, height: 50,
        font_size: 16, font_family: 'Helvetica', font_style: 'normal', missing_policy: 'error' }],
    } };
  const blob = bytes => ({ arrayBuffer: async () => bytes });
  const db = {
    storage: { from(bucket) {
      return {
        async download(path) {
          if (bucket === 'private-uploads') return { data: blob(source) };
          return artifacts.has(path) ? { data: blob(artifacts.get(path)) }
            : { data: null, error: { statusCode: 400, message: 'Object not found' } };
        },
        async upload(path, bytes, options) {
          assert.equal(bucket, 'speaker-certificates');
          assert.equal(options.upsert, false);
          if (artifacts.has(path)) return { error: { statusCode: 409, message: 'The resource already exists' } };
          artifacts.set(path, Buffer.from(bytes)); writes.push(path); return { data: { path } };
        },
      };
    } },
    async rpc(name, params) { completions.push({ name, params }); return { data: true }; },
    from(table) {
      assert.equal(table, 'speaker_recognition');
      const chain = {
        update(patch) { writes.push(patch); return chain; },
        eq() { return chain; }, is() { return chain; },
        then(resolve) { resolve({ error: null }); },
      };
      return chain;
    },
  };
  return { row, db, source, artifacts, writes, completions };
}

test('certificate-only config works and explicit null opts out without affecting inherited badge/voucher', () => {
  const config = normalizeSpeakerAwardConfig({ enabled: true, default: { certificate_template_id: 't1' },
    overrides: { none: { certificate_template_id: null }, inherit: {}, excluded: { excluded: true } } });
  assert.equal(resolveSpeakerAward(config, 'inherit').certificate_template_id, 't1');
  assert.equal(resolveSpeakerAward(config, 'none'), null);
  assert.deepEqual(resolveSpeakerAward(config, 'excluded'), { excluded: true });
});

test('speaker mappings have no booking, attendance, points or invented member evidence', () => {
  const values = speakerCertificateValues({ speaker_name: 'No email', event_title: 'Conference',
    event_start_date: '2026-10-01T12:00:00Z', event_end_date: '2026-10-02T12:00:00Z' });
  assert.equal(values['member.full_name'], 'No email');
  assert.equal(values['speaker.email'], '');
  assert.equal(values['attendee.full_name'], undefined);
  assert.equal(values['cpd.cpd_points'], undefined);
  assert.equal(values['cpd.activity_date_range'], '1 October 2026 – 2 October 2026');
  assert.throws(() => speakerCertificateFields([{ placeholder_key: 'cpd.cpd_points', missing_policy: 'error',
    default_value: '10', sample_value: '10' }], values), /Required speaker certificate value/);
  const [optional] = speakerCertificateFields([{ placeholder_key: 'cpd.cpd_points',
    missing_policy: 'literal', default_value: '10', sample_value: '10' }], values);
  assert.equal(optional.default_value, null);
  assert.equal(optional.missing_policy, 'blank');
  assert.equal(optional.sample_value, undefined);
});

test('real renderer creates PDF, private create-only upload recovers stable bytes after source/event edits', async () => {
  const { db, row, artifacts, writes, completions } = await fixture();
  assert.equal(await issueSpeakerCertificate(db, row), true);
  const original = artifacts.get('tenant/recognition.pdf');
  assert.equal(original.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await PDFDocument.load(original)).getPageCount(), 1);
  assert.equal(completions[0].params.p_sha256, hash(original));
  row.snapshot.event_title = 'Edited event';
  row.snapshot.template.source_sha256 = 'changed';
  assert.equal(await issueSpeakerCertificate(db, row), true);
  assert.deepEqual(artifacts.get('tenant/recognition.pdf'), original);
  assert.equal(writes.filter(value => typeof value === 'string').length, 1);
});

test('parallel retries use exactly one immutable PDF object', async () => {
  const { db, row, writes, completions } = await fixture();
  const result = await Promise.all([issueSpeakerCertificate(db, row), issueSpeakerCertificate(db, row)]);
  assert.deepEqual(result, [true, true]);
  assert.equal(writes.filter(value => typeof value === 'string').length, 1);
  assert.equal(completions[0].params.p_sha256, completions[1].params.p_sha256);
});

test('missing template and render errors are explicit, do not call legacy award/email paths', async () => {
  const { db, row, writes, completions } = await fixture();
  row.snapshot.template = null;
  assert.equal(await issueSpeakerCertificate(db, row), false);
  assert.equal(writes[0].certificate_status, 'error');
  assert.match(writes[0].error, /template is unavailable/);
  assert.equal(completions.length, 0);
  const other = await fixture();
  assert.equal(await issueSpeakerCertificate(other.db, other.row, { render: async () => { throw new Error('Render failed'); } }), false);
  assert.equal(other.writes[0].error, 'Render failed');
  assert.equal(other.artifacts.size, 0);
});

test('revoked and already-issued certificates have zero storage/write effects', async () => {
  const { db, row, writes, completions } = await fixture();
  assert.equal(await issueSpeakerCertificate(db, { ...row, status: 'revoked' }), false);
  assert.equal(await issueSpeakerCertificate(db, { ...row, certificate_status: 'issued' }), false);
  assert.equal(writes.length, 0);
  assert.equal(completions.length, 0);
});

test('storage permission errors cannot be treated as missing certificates', async () => {
  const { db, row, writes, completions } = await fixture();
  db.storage.from = () => ({ download: async () => ({ error: { statusCode: 403, message: 'Forbidden' } }) });
  assert.equal(await issueSpeakerCertificate(db, row), false);
  assert.match(writes[0].error, /Could not check/);
  assert.equal(completions.length, 0);
});