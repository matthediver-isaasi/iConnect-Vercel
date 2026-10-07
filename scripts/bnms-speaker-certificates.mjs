// Authorized one-event operational backfill. No policy changes or notifications.
import pg from 'pg';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { createClient } from '@supabase/supabase-js';
import { issueSpeakerCertificate, speakerCertificateValues, speakerCertificateFields } from '../api/_lib/speakerRecognition.js';
import { renderCpdCertificatePdf } from '../api/_lib/cpdCertificatePdf.js';

export const EVENT = '66050b3c-aa70-4174-8552-0a2af85e5410';
export const TEMPLATE = '8da553d8-dcba-4f42-bb66-c32758ed00aa';
const DIR = 'private/bnms-speaker-certificates';
const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
const APPROVED = '383a06f0829b46733df721ba522f30ba1b9bdf0b0838bfb793eb1a253891e774';
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const requireThat = (condition, label) => { if (!condition) throw new Error(label); };
async function connect() {
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  requireThat(response.ok, 'CA unavailable');
  const client = new pg.Client({ connectionString: target.toString(), ssl: {
    rejectUnauthorized: true, ca: await response.text(), servername: target.hostname,
  } });
  await client.connect();
  return client;
}
async function capture(client) {
  const one = async (sql, args = []) => (await client.query(sql, args)).rows[0]?.value;
  const event = await one('SELECT to_jsonb(e) value FROM event e WHERE id=$1', [EVENT]);
  requireThat(event, 'Event unavailable');
  const tenant = await one('SELECT jsonb_build_object(\'id\',id,\'name\',name,\'slug\',slug) value FROM tenant WHERE id=$1', [event.tenant_id]);
  const agenda = await one("SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'speaker_ids',speaker_ids) ORDER BY id),'[]') value FROM event_agenda_item WHERE tenant_id=$1 AND event_id=$2", [event.tenant_id, EVENT]);
  const ids = [...new Set([...(event.speaker_ids || []), ...agenda.flatMap(a => a.speaker_ids || [])])].sort();
  const speakers = await one("SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') value FROM speaker s WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [event.tenant_id, ids]);
  const grants = await one("SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY id),'[]') value FROM speaker_award_grant g WHERE tenant_id=$1 AND event_type='event' AND event_id=$2", [event.tenant_id, EVENT]);
  const members = await one("SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'tenant_id',tenant_id,'email',email,'role_id',role_id,'member_excluded_features',member_excluded_features) ORDER BY id),'[]') value FROM member WHERE id=ANY($1::uuid[])", [[...new Set([...speakers.map(s => s.member_id), ...grants.map(g => g.member_id)].filter(Boolean))]]);
  const template = await one('SELECT to_jsonb(t) value FROM cpd_certificate_template t WHERE id=$1', [TEMPLATE]);
  const fields = await one("SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY page_number,display_order,id),'[]') value FROM cpd_certificate_placeholder p WHERE template_id=$1", [TEMPLATE]);
  const policy = await one('SELECT to_jsonb(p) value FROM speaker_recognition_policy p');
  const contracts = (await client.query(`SELECT proname,pg_get_functiondef(oid) definition FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname IN
    ('sync_speaker_recognition','finish_speaker_certificate','protect_speaker_recognition_snapshot','revoke_detached_speaker_recognition')
    ORDER BY proname`)).rows;
  return { event, tenant, agenda, ids, speakers, grants, members, template, fields, policy, contracts };
}
export function recipients(input) {
  const { event, template, fields, policy, tenant } = input;
  requireThat(event.id === EVENT && event.tenant_id === TENANT && tenant.id === TENANT && tenant.slug === 'bnms', 'Event/tenant pin mismatch');
  requireThat(event.status === 'published' && event.event_state === 'closed', 'Event state drift');
  requireThat(event.start_date.startsWith('2026-09-24') && event.end_date.startsWith('2026-09-25'), 'Event dates drift');
  const cfg = event.speaker_award_config;
  requireThat(cfg?.enabled === true && cfg.default?.certificate_template_id === TEMPLATE
    && !cfg.default.badge_id && !Number(cfg.default.voucher_value)
    && Object.keys(cfg.overrides || {}).length === 0, 'Certificate-only configuration drift');
  requireThat(template?.id === TEMPLATE && template.tenant_id === event.tenant_id && template.status === 'active'
    && template.source_bucket === 'private-uploads' && template.source_path.startsWith(`${event.tenant_id}/`)
    && /^[a-f0-9]{64}$/.test(template.source_sha256)
    && fields.every(f => f.tenant_id === event.tenant_id), 'Template ownership invalid');
  requireThat(new Date(event.start_date) < new Date(policy.starts_at), 'Policy boundary changed');
  return input.ids.map(id => {
    const speaker = input.speakers.find(s => s.id === id);
    if (!speaker) return { id, skipped: 'missing_or_wrong_tenant_speaker' };
    const grants = input.grants.filter(g => g.speaker_id === id);
    requireThat(grants.length <= 1, 'Ambiguous grants');
    const grant = grants[0];
    requireThat(!(grant?.member_id && speaker.member_id && grant.member_id !== speaker.member_id), 'Conflicting persisted ownership');
    const memberId = grant?.member_id || speaker.member_id;
    if (!memberId) return { id, skipped: 'unlinked' };
    const member = input.members.find(m => m.id === memberId);
    requireThat(member?.tenant_id === event.tenant_id && !/^deleted_.+@deleted[.]local$/.test(member.email || ''), 'Invalid persisted member');
    return { id, memberId, snapshot: {
      speaker_name: speaker.full_name, speaker_email: speaker.email, organization: speaker.organization,
      event_title: event.title, event_start_date: event.start_date, event_end_date: event.end_date,
      event_timezone: event.timezone, badge: null, badge_evidence: 'member_badge',
      template, placeholders: fields, member_id: memberId,
    } };
  });
}
export function recognitionId(speakerId) {
  const h = hash(`${APPROVED}:${speakerId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
async function recognitionRows(client) {
  return (await client.query("SELECT to_jsonb(r) value FROM speaker_recognition r WHERE tenant_id=$1 AND event_type='event' AND event_id=$2 ORDER BY speaker_id", [TENANT, EVENT])).rows.map(r => r.value);
}
function checkExisting(rows, approved) {
  for (const row of rows) {
    const recipient = approved.find(r => r.id === row.speaker_id && !r.skipped);
    requireThat(recipient && row.id === recognitionId(recipient.id) && row.member_id === recipient.memberId
      && row.status === 'active' && row.certificate_template_id === TEMPLATE
      && !row.grant_id && !row.badge_id && !row.member_badge_id && equal(row.snapshot, recipient.snapshot)
      && ['pending', 'error', 'issued'].includes(row.certificate_status), 'Unexpected existing recognition');
  }
}
async function evidence(client) {
  // Read-only digests, not private row dumps. Tenant-scoped evidence may also
  // change through unrelated live activity; a mismatch is never hidden.
  const tables = (await client.query(`SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='tenant_id'
    AND (table_name IN ('speaker_award_grant','member_badge','voucher','cpd_point','cpd_points',
      'cpd_certificate','invoice','payment','transactional_email','member_notification','email_log',
      'member_cpd_points_ledger','member_transactional_message','attendee_cpd_certificate_delivery',
      'event_cpd_points_award_attempt','event_cpd_points_outbox','event_cpd_badge_award_attempt',
      'event_cpd_badge_outbox','membership_instalment_invoices','sales_accounting_invoice_attempt',
      'sales_accounting_invoice_link')
      OR table_name LIKE '%cpd%transaction%' OR table_name LIKE '%inbox%')
    ORDER BY table_name`)).rows.map(r => r.table_name);
  const result = {};
  for (const table of tables) {
    requireThat(/^[a-z_]+$/.test(table), 'Invalid evidence table');
    result[table] = (await client.query(`SELECT count(*)::int count,
      md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) digest
      FROM public."${table}" t WHERE tenant_id=$1`, [TENANT])).rows[0];
  }
  return result;
}
async function guards(client) {
  const r = (await client.query(`SELECT
    NOT public AS bucket_private,
    NOT has_table_privilege('authenticated','speaker_recognition','SELECT') AS rows_private,
    NOT has_table_privilege('anon','speaker_award_history','SELECT') AS history_private,
    NOT has_function_privilege('authenticated','finish_speaker_certificate(uuid,uuid,text,text)','EXECUTE') AS finalizer_private,
    EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
      AND policyname='speaker_certificates_service_only' AND permissive='RESTRICTIVE') AS storage_guard
    FROM storage.buckets WHERE id='speaker-certificates'`)).rows[0];
  requireThat(r && Object.values(r).every(v => v === true), 'Privacy guards failed');
  return r;
}
async function execute(client, input, approved, mode) {
  requireThat(hash(input) === APPROVED, 'Reviewed manifest mismatch');
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) },
  });
  await guards(client);
  requireThat(equal(await capture(client), input), 'Live inputs changed');
  const before = await evidence(client);
  await writeFile(`${DIR}/baseline-${Date.now()}.json`, JSON.stringify(before), { mode: 0o600 });
  const initial = await recognitionRows(client);
  checkExisting(initial, approved);
  if (mode === '--verify') requireThat(initial.length === approved.filter(r => !r.skipped).length, 'Incomplete issuance');
  const source = await db.storage.from('private-uploads').download(input.template.source_path);
  requireThat(!source.error && source.data, 'Private template download failed');
  const sourceBytes = Buffer.from(await source.data.arrayBuffer());
  requireThat(hash(sourceBytes) === input.template.source_sha256, 'Template source hash mismatch');
  let issued = 0;
  for (const recipient of approved.filter(r => !r.skipped)) {
    if (initial.some(r => r.speaker_id === recipient.id && r.certificate_status === 'issued')) continue;
    requireThat(mode === '--execute', 'Unissued recipient');
    // Render before acquiring locks to avoid blocking edits during PDF work.
    const rendered = await renderCpdCertificatePdf(sourceBytes,
      speakerCertificateFields(input.fields, speakerCertificateValues(recipient.snapshot)),
      speakerCertificateValues(recipient.snapshot));
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
      // SHARE locks prevent new references/fields/grants (phantoms), as well as
      // ownership edits, for this short upload/finalize transaction. No DDL.
      await client.query(`LOCK TABLE event_agenda_item,speaker,member,speaker_award_grant,
        cpd_certificate_template,cpd_certificate_placeholder,speaker_recognition_policy IN SHARE MODE`);
      await client.query('SELECT id FROM event WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [TENANT, EVENT]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,4838))", [`${TENANT}event${EVENT}`]);
      requireThat(equal(await capture(client), input), 'Locked inputs changed');
      const current = await recognitionRows(client);
      checkExisting(current, approved);
      let row = current.find(r => r.speaker_id === recipient.id);
      if (row?.certificate_status === 'issued') { await client.query('ROLLBACK'); continue; }
      if (!row) {
        row = (await client.query(`INSERT INTO speaker_recognition
          (id,tenant_id,event_type,event_id,speaker_id,member_id,certificate_template_id,certificate_status,snapshot)
          VALUES ($1,$2,'event',$3,$4,$5,$6,'pending',$7) RETURNING to_jsonb(speaker_recognition) value`,
        [recognitionId(recipient.id), TENANT, EVENT, recipient.id, recipient.memberId, TEMPLATE, recipient.snapshot])).rows[0].value;
      }
      // Run the unchanged production pipeline, but keep its finalizer on this
      // same locked SQL transaction. Errors throw and roll back this recipient.
      const adapter = {
        storage: { from: bucket => {
          const storage = db.storage.from(bucket);
          return {
            upload: (...args) => storage.upload(...args),
            download: async path => {
              const result = await storage.download(path);
              // This SDK version wraps a Storage 400 JSON response instead of
              // exposing its embedded 404. Normalize only explicit NoSuchKey.
              const response = result.error?.originalError;
              if (response instanceof Response && response.status === 400) {
                const body = await response.clone().json().catch(() => null);
                if (body?.code === 'NoSuchKey' && body.statusCode === '404'
                  && body.message === 'Object not found') {
                  return { data: null, error: { statusCode: '404', error: 'not_found' } };
                }
              }
              return result;
            },
          };
        } },
        rpc: async (name, p) => {
          requireThat(name === 'finish_speaker_certificate', 'Unexpected RPC');
          return { data: (await client.query('SELECT finish_speaker_certificate($1,$2,$3,$4) done',
            [p.p_tenant, p.p_id, p.p_path, p.p_sha256])).rows[0].done, error: null };
        },
        from: () => ({ update: patch => {
          writeFileSync(`${DIR}/issuance-error.json`, JSON.stringify({ error: patch.error }), { mode: 0o600 });
          throw new Error('Certificate issuance failed; transaction rolled back');
        } }),
      };
      requireThat(await issueSpeakerCertificate(adapter, row, { render: async () => rendered }), 'Finalization rejected');
      await client.query('COMMIT');
      issued++;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  const final = await recognitionRows(client);
  checkExisting(final, approved);
  requireThat(final.length === approved.filter(r => !r.skipped).length, 'Recognition count mismatch');
  for (const row of final) {
    requireThat(row.certificate_status === 'issued' && row.pdf_path === `${TENANT}/${row.id}.pdf`, 'Certificate not issued');
    const file = await db.storage.from('speaker-certificates').download(row.pdf_path);
    requireThat(!file.error && file.data, 'Issued PDF unavailable');
    const bytes = Buffer.from(await file.data.arrayBuffer());
    requireThat(bytes.subarray(0, 5).toString() === '%PDF-' && hash(bytes) === row.pdf_sha256, 'Issued PDF integrity failed');
    await writeFile(`${DIR}/${row.id}.pdf`, bytes, { mode: 0o600 });
    const history = await db.from('speaker_award_history').select('id,certificate_available')
      .eq('tenant_id', TENANT).eq('member_id', row.member_id).eq('id', row.id).single();
    requireThat(!history.error && history.data?.certificate_available, 'Member history unavailable');
  }
  requireThat(equal(await capture(client), input), 'Post-operation inputs changed');
  const after = await evidence(client);
  requireThat(equal(before, after), 'Side-effect evidence changed; inspect privately');
  if (mode === '--verify' || issued === 0) requireThat(equal(initial, final), 'Replay changed rows');
  const report = { mode, eligible: final.length, issued, skipped: approved.filter(r => r.skipped).length,
    failed: 0, privatePdfHashesVerified: final.length, memberHistoryVerified: final.length,
    sideEffectsUnchanged: true, evidenceTables: Object.keys(before), before, after, rows: final,
    authenticatedBrowserVerified: false, migrationsApplied: [] };
  await writeFile(`${DIR}/${mode.slice(2)}-report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, before: undefined, after: undefined, rows: undefined }));
}
export async function main(args = process.argv.slice(2)) {
  requireThat(args.length === 1 && ['--preview', '--execute', '--verify'].includes(args[0]), 'Use --preview, --execute, or --verify');
  const client = await connect();
  try {
    if (args[0] !== '--preview') {
      const input = JSON.parse(await readFile(`${DIR}/preview.json`, 'utf8'));
      await execute(client, input, recipients(input), args[0]);
      return;
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const input = await capture(client);
    await mkdir(DIR, { recursive: true, mode: 0o700 });
    await writeFile(`${DIR}/preview.json`, JSON.stringify(input, null, 2), { mode: 0o600 });
    await writeFile(`${DIR}/contracts.sql`, input.contracts.map(c => c.definition).join('\n'), { mode: 0o600 });
    const rows = recipients(input);
    const existing = (await client.query("SELECT count(*)::int n FROM speaker_recognition WHERE event_type='event' AND event_id=$1", [EVENT])).rows[0].n;
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ manifestHash: hash(input), tenantId: input.tenant.id, speakers: rows.length,
      eligible: rows.filter(r => !r.skipped).length, skipped: rows.filter(r => r.skipped).length, existing }));
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Operation stopped: ${error.code || (error.message.length < 100 ? error.message : 'validation failure')}`); process.exitCode = 1; });
}
