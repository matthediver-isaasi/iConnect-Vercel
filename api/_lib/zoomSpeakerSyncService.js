import { supabase } from './database.js';
import { getZoomAccessTokenForTenant } from './zoomClient.js';
import { reconcileZoomSpeakers } from './zoomSpeakerSync.js';

// Link persistence must not be reported as failed when Zoom is unavailable.
export async function syncAttachedWebinarSpeakers(tenantId, webinarId) {
  if (!webinarId) return null;
  try {
    const queued = await supabase.rpc('queue_zoom_speakers', { p_tenant: tenantId, p_webinar: webinarId });
    if (queued.error) throw new Error('Speaker synchronisation database setup is unavailable');
    await runZoomSpeakerSync({ tenantId, webinarId, deadlineAt: Date.now() + 10000 });
    const result = await supabase.from('zoom_speaker_sync').select('status,last_error,summary')
      .eq('tenant_id',tenantId).eq('webinar_id',webinarId).maybeSingle();
    if (result.error) throw new Error('Could not read panelist synchronisation status');
    return result.data;
  } catch (error) { return { status:'attention', last_error:error.message }; }
}

export async function runZoomSpeakerSync({ tenantId = null, webinarId = null, db = supabase, deadlineAt = Date.now() + 20000 } = {}) {
  const { data: job, error } = await db.rpc('claim_zoom_speaker_sync', { p_tenant: tenantId, p_webinar: webinarId });
  if (error) throw new Error('Speaker synchronisation database setup is unavailable');
  if (!job) return false;
  const checkpoint = async (patch, fence = false) => {
    const { data, error } = await db.rpc('checkpoint_zoom_speaker_sync', {
      p_webinar: job.webinar_id, p_tenant: job.tenant_id, p_token: job.lease_token,
      p_generation: job.generation, p_patch: patch, p_fence: fence,
    });
    if (error || !data) {
      if (fence && !error) return false;
      throw new Error('Speaker synchronisation lease changed; the queued job will retry');
    }
    return true;
  };
  let token;
  const api = async (suffix = '', options = {}) => {
    token ||= await getZoomAccessTokenForTenant(job.tenant_id);
    if (options.method && options.method !== 'GET' && !await checkpoint({}, true)) {
      throw new Error('Speaker selection changed before the Zoom request');
    }
    const response = await fetch(`https://api.zoom.us/v2/webinars/${encodeURIComponent(job.provider_id)}/panelists${suffix}`, {
      ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Zoom panelist request failed (${response.status}). Check the Zoom connection and webinar permissions.`);
    return response.status === 204 ? null : response.json();
  };
  await reconcileZoomSpeakers(job, {
    fence: () => checkpoint({}, true), save: patch => checkpoint(patch),
    expired: () => Date.now() > deadlineAt,
    async list() {
      const data = await api();
      if (!Array.isArray(data?.panelists) || data.next_page_token
        || (data.total_records != null && Number(data.total_records) !== data.panelists.length)) {
        throw new Error('Zoom panelist list was incomplete; existing panelists have been retained.');
      }
      return data.panelists;
    },
    async add(person) {
      const data = await api('', { method: 'POST', body: JSON.stringify({ panelists: [person] }) });
      return data?.panelists?.find(p => String(p.email || '').trim().toLowerCase() === person.email);
    },
    remove: id => api(`/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  });
  return true;
}
