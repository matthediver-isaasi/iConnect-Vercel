import { supabase } from './database.js';
import { randomUUID } from 'node:crypto';

export function publicZoomJob(job) {
  if (!job) return null;
  return {
    id: job.id, status: job.status, processed: job.cursor,
    total: job.booking_ids.length, totals: job.totals,
    error: job.last_error, emailRequested: job.email_requested,
    createdAt: job.created_at,
  };
}

export async function latestZoomJob(tenantId, kind, id) {
  const { data, error } = await supabase.from('zoom_registration_job').select('*')
    .eq('tenant_id', tenantId).eq('resource_kind', kind).eq('resource_id', id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('Could not load background registration status');
  return publicZoomJob(data);
}

// Called after the existing authenticated attach path has verified the provider.
// A lost enqueue response is safe to retry with the same request key.
export async function enqueueZoomJob({ tenantId, kind, id, body, bookings, target, actor, expected, patch }) {
  const requestKey = body.requestKey || randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey)) {
    throw new Error('Invalid registration request key');
  }
  const { data, error } = await supabase.rpc('enqueue_zoom_registration_job', { p_job: {
    tenant_id: tenantId, resource_kind: kind, resource_id: id, request_key: requestKey,
    target, booking_ids: bookings.map(b => b.id), email_requested: body.resendConfirmations === true,
    created_by: actor || null,
  }, p_expected: expected, p_patch: patch });
  if (!error) return publicZoomJob(data);
  if (error.code === '23505') {
    const { data: existing, error: readError } = await supabase.from('zoom_registration_job').select('*')
      .eq('tenant_id', tenantId).eq('request_key', requestKey).maybeSingle();
    if (!readError && existing && existing.resource_kind === kind && existing.resource_id === id) return publicZoomJob(existing);
    throw new Error('Registration is already running for this event or session. Reopen the dialog to view progress.');
  }
  throw new Error('Could not save registration job. No background registration was started.');
}
