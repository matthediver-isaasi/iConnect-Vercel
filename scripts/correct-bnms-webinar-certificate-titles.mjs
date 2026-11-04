// Owner-authorised, event-scoped correction. Never calls email or CPD award APIs.
// Original issuance metadata and private PDF remain retained in each correction.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { connectDestination } from './lib/member-index-destination.mjs';
import { realCertificatePlaceholders } from '../api/_lib/attendeeCpdCertificate.js';
import { renderCpdCertificatePdf } from '../api/_lib/cpdCertificatePdf.js';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const event = '4a21aa95-0c72-4317-a8eb-638ec73c96b0';
const originalTemplate = 'a1fc1957-7500-41ac-9d31-45d6af53f74b';
const marker = 'event-title-mapping-correction-2026-11-04';
const apply = process.argv.includes('--apply');
const hash = value => createHash('sha256').update(value).digest('hex');
const db = await connectDestination();
assert.equal(new URL(process.env.DEST_SUPABASE_URL).hostname, 'lvmzliemqnieeoruhkik.supabase.co');
const storage = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }).storage;
const staged = [];
let transaction = false;
let committed = false;
let commitAttempted = false;
const download = async (bucket, path, sha) => {
  const { data, error } = await storage.from(bucket).download(path);
  if (error) throw error;
  const bytes = Buffer.from(await data.arrayBuffer());
  assert.equal(hash(bytes), sha, 'Private PDF integrity mismatch');
  return bytes;
};
const upload = async (bucket, path, bytes) => {
  const { error } = await storage.from(bucket).upload(path, bytes,
    { contentType: 'application/pdf', upsert: false });
  if (error) throw error;
  staged.push({ bucket, path });
  await download(bucket, path, hash(bytes));
};
const scopeSql = `select c.* from issued_cpd_certificate c join booking b
  on c.tenant_id=b.tenant_id and c.certificate_key='standard:'||b.id::text
  where b.tenant_id=$1 and b.event_id=$2 order by c.certificate_key`;
const fixFields = fields => {
  assert.equal(fields.filter(f => f.placeholder_key === 'historic_event_title').length, 1);
  return fields.map(f => f.placeholder_key === 'historic_event_title'
    ? { ...f, placeholder_key: 'event.name', label: 'Event name' } : f);
};
try {
  await db.query('begin read only'); transaction = true;
  const records = (await db.query(scopeSql, [tenant, event])).rows;
  assert.equal(records.length, 39, 'Issued scope changed; review before proceeding');
  if (records.every(r => r.snapshot.correction?.marker === marker)) {
    console.log('All 39 corrections already applied; no writes.');
  } else {
    assert(records.every(r => !r.snapshot.correction), 'Mixed/prior correction requires review');
    const template = (await db.query('select * from cpd_certificate_template where tenant_id=$1 and id=$2',
      [tenant, originalTemplate])).rows[0];
    assert.equal(template.status, 'active');
    const fields = (await db.query('select * from cpd_certificate_placeholder where tenant_id=$1 and template_id=$2 order by display_order',
      [tenant, originalTemplate])).rows;
    const config = (await db.query('select * from event_cpd_certificate_config where tenant_id=$1 and event_id=$2 and event_type=$3',
      [tenant, event, 'event'])).rows[0];
    assert.equal(config.config.eventRule.template_id, originalTemplate);
    assert.deepEqual(config.config.ticketRules, {});
    const title = (await db.query('select title from event where tenant_id=$1 and id=$2', [tenant, event])).rows[0].title;
    await db.query('rollback'); transaction = false;
    const source = await download('private-uploads', template.source_path, template.source_sha256);
    const correctedFields = fixFields(fields);
    const replacements = [];
    await mkdir('generated-artifacts/cpd-reissue', { recursive: true });
    for (const record of records) {
      assert.equal(record.snapshot.template.id, originalTemplate);
      assert.equal(record.snapshot.template.source_sha256, template.source_sha256);
      assert.equal(record.snapshot.values['event.name'], title);
      assert(record.source_path.startsWith(`${tenant}/issued-cpd/`));
      await download('issued-cpd-certificates', record.source_path, record.pdf_sha256);
      const next = { ...record.snapshot, placeholders: fixFields(record.snapshot.placeholders) };
      // All values, points, dates, signatures and geometry stay exactly as issued.
      const prepared = realCertificatePlaceholders(next.placeholders, next.values);
      assert.deepEqual(prepared.missing, []);
      const pdf = await renderCpdCertificatePdf(source, prepared.placeholders, next.values);
      if (!replacements.length) await writeFile('generated-artifacts/cpd-reissue/check.pdf', pdf);
      replacements.push({ record, next, pdf, path: `${tenant}/issued-cpd/${randomUUID()}.pdf` });
    }
    console.log(JSON.stringify({ dryRun: !apply, prepared: replacements.length, title }));
    if (apply) {
      const copyId = randomUUID();
      const sourcePath = `${tenant}/cpd-certificate-templates/${copyId}/v1.pdf`;
      await upload('private-uploads', sourcePath, source);
      for (const replacement of replacements)
        await upload('issued-cpd-certificates', replacement.path, replacement.pdf);
      await db.query('begin'); transaction = true;
      await db.query('set local lock_timeout = \'5s\'');
      const locked = (await db.query(scopeSql + ' for update of c', [tenant, event])).rows;
      assert.deepEqual(locked, records, 'Issued certificates changed during preparation');
      const current = (await db.query('select * from cpd_certificate_template where tenant_id=$1 and id=$2 for update',
        [tenant, originalTemplate])).rows[0];
      assert.deepEqual(current, template, 'Source template changed during preparation');
      const copyName = 'Standard CPD certificate — event title corrected 4-Nov-26';
      // A new template follows draft -> review -> approved -> active.
      // Approval actor records the owner's explicit correction instruction, not an impersonated account.
      const copy = { ...template, id: copyId, name: copyName, status: 'draft', version: 1,
        source_path: sourcePath, created_by: 'owner-authorised-certificate-correction',
        updated_by: 'owner-authorised-certificate-correction', review_requested_at: null,
        reviewed_at: null, reviewed_by: null, review_note: null, archived_at: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      await db.query('insert into cpd_certificate_template select (jsonb_populate_record(null::cpd_certificate_template,$1::jsonb)).*',
        [JSON.stringify(copy)]);
      await db.query('select save_cpd_certificate_template_checked($1,$2,$3,$4,$5,$6::jsonb,$7)',
        [copyId, tenant, 1, copyName, template.description, JSON.stringify(correctedFields), copy.updated_by]);
      await db.query("update cpd_certificate_template set status='in_review',review_requested_at=now(),version=version+1 where tenant_id=$1 and id=$2 and status='draft'", [tenant, copyId]);
      await db.query("update cpd_certificate_template set status='approved',reviewed_at=now(),reviewed_by=$3,review_note=$4,version=version+1 where tenant_id=$1 and id=$2 and status='in_review'",
        [tenant, copyId, copy.updated_by, 'Owner requested corrected event-title mapping and silent reissue; no email or award changes.']);
      await db.query("update cpd_certificate_template set status='active',version=version+1,updated_at=now() where tenant_id=$1 and id=$2 and status='approved'", [tenant, copyId]);
      const activated = (await db.query('select status,version from cpd_certificate_template where tenant_id=$1 and id=$2', [tenant, copyId])).rows[0];
      assert.deepEqual(activated, { status: 'active', version: 5 });
      const nextConfig = structuredClone(config.config);
      nextConfig.eventRule.template_id = copyId;
      const changedConfig = await db.query('update event_cpd_certificate_config set config=$4::jsonb,updated_at=now() where tenant_id=$1 and event_id=$2 and event_type=$3 and config=$5::jsonb',
        [tenant, event, 'event', JSON.stringify(nextConfig), JSON.stringify(config.config)]);
      assert.equal(changedConfig.rowCount, 1, 'Event configuration changed during preparation');
      for (const item of replacements) {
        // Preserve the complete previous row, including its immutable PDF pointer.
        // Original capture date/reason remain unchanged; correction has its own timestamp.
        item.next.correction = { marker, corrected_at: new Date().toISOString(),
          reason: 'Replace missing historic_event_title mapping with recorded event.name',
          corrected_template_id: copyId, email_sent: false, previous_issuance: item.record };
        const updated = await db.query(`update issued_cpd_certificate set source_path=$3,pdf_sha256=$4,snapshot=$5::jsonb
          where tenant_id=$1 and certificate_key=$2 and pdf_sha256=$6 and snapshot=$7::jsonb`,
        [tenant, item.record.certificate_key, item.path, hash(item.pdf), JSON.stringify(item.next),
          item.record.pdf_sha256, JSON.stringify(item.record.snapshot)]);
        assert.equal(updated.rowCount, 1);
      }
      const after = (await db.query(scopeSql, [tenant, event])).rows;
      assert.equal(after.length, 39);
      for (let i = 0; i < after.length; i++) {
        const old = records[i], updated = after[i];
        assert.deepEqual(updated.snapshot.values, old.snapshot.values);
        assert.equal(updated.snapshot.award_signature, old.snapshot.award_signature);
        assert.equal(updated.capture_reason, old.capture_reason);
        assert.deepEqual(updated.captured_at, old.captured_at);
        assert.equal(updated.snapshot.correction.previous_issuance.pdf_sha256, old.pdf_sha256);
        assert.equal(updated.snapshot.correction.previous_issuance.source_path, old.source_path);
        assert.notEqual(updated.pdf_sha256, old.pdf_sha256);
      }
      commitAttempted = true;
      await db.query('commit'); transaction = false; committed = true;
      console.log(JSON.stringify({ corrected: 39, template: copyName, templateId: copyId,
        originalsRetained: 39, emailsSent: 0, pointsChanged: 0 }));
    }
  }
} catch (error) {
  if (transaction) await db.query('rollback');
  // If COMMIT's response is lost, publication is uncertain: never delete its PDFs.
  if (!committed && !commitAttempted) for (const item of staged) {
    const { error: cleanupError } = await storage.from(item.bucket).remove([item.path]);
    if (cleanupError) console.error('Unpublished private staging cleanup failed:', item.bucket, item.path);
  }
  throw error;
} finally {
  await db.end();
}
