import { createHash } from 'node:crypto';
import { handleAttendeeCertificate } from '../reports/attendee-cpd-certificate.js';

// Server-only adapter. Never expose the injected context through an HTTP route.
export async function sendAutomaticAttendanceCertificate(db, row, handler = handleAttendeeCertificate) {
  if (row.trigger_type !== 'attendance') return { status: 'not_attendance' };
  const { data: outcome, error } = await db.from('attendance_current_outcome')
    .select('status').eq('tenant_id', row.tenant_id).eq('booking_type', row.booking_type)
    .eq('booking_id', row.booking_id).eq('status', 'attended').limit(1);
  if (error) throw error;
  if (!outcome?.length) return { status: 'not_qualifying' };
  const source = row.booking_type === 'booking' ? 'standard'
    : row.booking_type === 'complex_event_booking' ? 'complex' : null;
  if (!source) throw new Error('Unsupported certificate booking source');
  const previous = await db.from('attendee_cpd_certificate_delivery').select('id')
    .eq('tenant_id',row.tenant_id).eq('booking_source',source).eq('booking_id',row.booking_id)
    .eq('purpose','attendee').eq('status','accepted').limit(1);
  if(previous.error) throw previous.error;
  if(previous.data?.length) return {status:'already_sent'};
  const identity = { booking_id: row.booking_id, booking_source: source };
  const deps = { db, contextFor: async () => ({ tenantId: row.tenant_id, isAuthenticated: true }),
    adminAccess: async () => true, actor: 'system:attendance-certificate' };
  async function call(method, body) {
    let status = 200, result;
    const res = { setHeader() {}, status(code) { status = code; return this; },
      json(value) { result = value; return this; } };
    await handler({ method, query: identity, body }, res, deps);
    if (status >= 500) throw new Error(result?.error || 'Certificate service unavailable');
    return { status, result };
  }
  const preview = await call('GET');
  if (preview.status !== 200) throw new Error(preview.result?.error || 'Certificate eligibility check failed');
  const info = preview.result;
  if (info.latest_delivery?.status === 'accepted') return { status: 'already_sent' };
  if (['pending','unknown'].includes(info.latest_delivery?.status)) {
    throw new Error('Certificate delivery needs reconciliation; no resend attempted');
  }
  if (!info.can_send || info.award_required) return {
    status: 'ineligible', reason: info.send_reason || info.reason || 'Member CPD award requires review',
  };
  // Retries after a definite failure use a new deterministic request. Concurrent
  // workers seeing the same last delivery still claim exactly the same request.
  const digest = createHash('sha256').update(
    `${row.tenant_id}:${source}:${row.booking_id}:attendance:${info.latest_delivery?.id || 'first'}`
  ).digest('hex');
  const requestId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
  const sent = await call('POST', { ...identity, action: 'send', confirmed: true,
    expected_fingerprint: info.fingerprint, request_id: requestId, deliberate_resend: false });
  if (!sent.result?.success) throw new Error(sent.result?.error || 'Certificate send did not succeed');
  return { status: 'accepted' };
}
