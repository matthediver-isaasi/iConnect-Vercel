import { createHash } from 'node:crypto';
import { renderCpdCertificatePdf } from './cpdCertificatePdf.js';
import { certificateDatePlaceholderValues, eventDateOnly } from '../../shared/eventCpdCertificatePolicy.js';

export const SPEAKER_CERTIFICATE_BUCKET = 'speaker-certificates';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Deliberately no booking, attendee, attendance or points placeholders. The
// member.full_name alias is the existing template library's recipient field;
// it names the speaker and does not assert that an external speaker is a member.
export function speakerCertificateValues(snapshot) {
  return {
    ...certificateDatePlaceholderValues({
      start_date: eventDateOnly(snapshot.event_start_date, snapshot.event_timezone || 'Europe/London'),
      end_date: eventDateOnly(snapshot.event_end_date, snapshot.event_timezone || 'Europe/London'),
    }),
    'speaker.full_name': snapshot.speaker_name || '',
    'speaker.email': snapshot.speaker_email || '',
    'member.full_name': snapshot.speaker_name || '',
    'organisation.name': snapshot.organization || '',
    'event.name': snapshot.event_title || '',
    'cpd.activity_title': snapshot.event_title || '',
    'event.start_date': snapshot.event_start_date || '',
    'event.end_date': snapshot.event_end_date || '',
  };
}

export function speakerCertificateFields(fields, values) {
  return (fields || []).map(({ sample_value, default_value, ...field }) => {
    if (field.missing_policy === 'error'
      && (values[field.placeholder_key] == null || String(values[field.placeholder_key]).trim() === '')) {
      throw new Error(`Required speaker certificate value unavailable: ${field.placeholder_key}`);
    }
    return { ...field, default_value: null, missing_policy: field.missing_policy === 'error' ? 'error' : 'blank' };
  });
}

export async function syncSpeakerRecognition(db, { tenantId, eventType, eventId }) {
  const { error } = await db.rpc('sync_speaker_recognition', {
    p_tenant: tenantId, p_type: eventType, p_event: eventId,
  });
  if (error) throw new Error(`Speaker recognition reconciliation failed: ${error.message}`);
}

// Uploads are create-only at a deterministic key. A crash after upload recovers
// the original bytes, never renders over or replaces an issued artifact.
export async function issueSpeakerCertificate(db, row, { render = renderCpdCertificatePdf } = {}) {
  if (row.status !== 'active' || !['pending', 'error'].includes(row.certificate_status) || !row.certificate_template_id) return false;
  const path = `${row.tenant_id}/${row.id}.pdf`;
  const bucket = db.storage.from(SPEAKER_CERTIFICATE_BUCKET);
  try {
    let { data: stored, error: storageError } = await bucket.download(path);
    let bytes;
    if (stored) {
      bytes = Buffer.from(await stored.arrayBuffer());
    } else {
      // Only a not-found can justify rendering. Transient/authorization storage
      // failures must not be silently treated as an absent immutable artifact.
      const status = String(storageError?.statusCode || storageError?.status || '');
      const notFound = status === '404' || storageError?.error === 'not_found'
        || (status === '400' && /^(Object not found|The resource was not found)$/i.test(storageError.message || ''));
      if (storageError && !notFound) {
        throw new Error('Could not check the private speaker certificate artifact');
      }
      const template = row.snapshot?.template;
      if (!template || template.status !== 'active' || template.tenant_id !== row.tenant_id
        || template.source_bucket !== 'private-uploads'
        || !template.source_path?.startsWith(`${row.tenant_id}/`) || !template.source_sha256) {
        throw new Error('The selected active tenant-private speaker certificate template is unavailable');
      }
      const source = await db.storage.from('private-uploads').download(template.source_path);
      if (source.error || !source.data) throw new Error('The private speaker certificate template PDF is unavailable');
      const sourceBytes = Buffer.from(await source.data.arrayBuffer());
      if (digest(sourceBytes) !== template.source_sha256) throw new Error('The snapshotted speaker certificate template source has changed');
      const values = speakerCertificateValues(row.snapshot);
      const fields = speakerCertificateFields(row.snapshot.placeholders, values);
      bytes = Buffer.from(await render(sourceBytes, fields, values));
      const uploaded = await bucket.upload(path, bytes, { contentType: 'application/pdf', upsert: false, cacheControl: '0' });
      if (uploaded.error) {
        // Another worker can win this key. Use its immutable bytes only on an
        // actual create conflict, not after arbitrary storage errors.
        if (!['409', '400'].includes(String(uploaded.error.statusCode || uploaded.error.status))
          || !/already exists|duplicate/i.test(uploaded.error.message || '')) throw uploaded.error;
        const winner = await bucket.download(path);
        if (winner.error || !winner.data) throw new Error('The concurrently issued speaker certificate could not be read');
        bytes = Buffer.from(await winner.data.arrayBuffer());
      }
    }
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Stored speaker certificate is not a PDF');
    const { error, data } = await db.rpc('finish_speaker_certificate', {
      p_tenant: row.tenant_id, p_id: row.id, p_path: path, p_sha256: digest(bytes),
    });
    if (error) throw error;
    return data === true;
  } catch (error) {
    const result = await db.from('speaker_recognition')
      .update({ certificate_status: 'error', error: String(error.message || error).slice(0, 500) })
      .eq('tenant_id', row.tenant_id).eq('id', row.id).eq('status', 'active').is('pdf_path', null);
    if (result.error) throw new Error('Failed to record speaker certificate processing error');
    return false;
  }
}

// Independent sweep: completed member badge/voucher event markers never
// suppress certificate retries. The deployment cutoff forbids retrospective
// issuance for events that had already started when this feature was enabled.
export async function processSpeakerRecognition(db, { limit = 20, now = new Date() } = {}) {
  const summary = { events: 0, issued: 0, errors: [] };
  const policy = await db.from('speaker_recognition_policy').select('starts_at').eq('singleton', true).single();
  if (policy.error || !policy.data) throw new Error('Speaker recognition migration/policy unavailable');
  const refreshed = await db.rpc('refresh_speaker_recognition_badges');
  if (refreshed.error) summary.errors.push({ error: `Speaker badge evidence refresh failed: ${refreshed.error.message}` });
  for (const eventType of ['event', 'complex_event']) {
    const events = await db.from(eventType).select('id,tenant_id')
      .is('speaker_recognition_processed_at', null).not('speaker_award_config', 'is', null)
      .eq('status', 'published').or('event_state.is.null,event_state.neq.draft')
      .gte('start_date', policy.data.starts_at).lte('start_date', now.toISOString())
      .order('start_date').order('id').limit(limit);
    if (events.error) throw events.error;
    for (const event of events.data || []) {
      try {
        await syncSpeakerRecognition(db, { tenantId: event.tenant_id, eventType, eventId: event.id });
        summary.events++;
      } catch (error) {
        summary.errors.push({ event_id: event.id, error: error.message });
      }
    }
  }
  // Oldest attempt first prevents a bad template starving the remaining queue.
  const pending = await db.from('speaker_recognition').select('*').eq('status', 'active')
    .in('certificate_status', ['pending', 'error']).order('last_attempt_at', { ascending: true, nullsFirst: true }).order('id').limit(limit);
  if (pending.error) throw pending.error;
  for (const row of pending.data || []) {
    const attempt = await db.from('speaker_recognition').update({ last_attempt_at: now.toISOString() })
      .eq('tenant_id', row.tenant_id).eq('id', row.id);
    if (attempt.error) throw attempt.error;
    if (await issueSpeakerCertificate(db, row)) summary.issued++;
  }
  return summary;
}