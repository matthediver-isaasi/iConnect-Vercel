import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { runZoomSpeakerSync } from '../../_lib/zoomSpeakerSyncService.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const ctx = await getTenantContext(req);
  if (!ctx?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  if (!ctx.tenantId || ctx.tenantMismatch || !await hasAdminAccess(ctx)) return res.status(403).json({ error: 'Admin access required' });
  try {
    const { data: event, error } = await supabase.from('event').select('zoom_webinar_id')
      .eq('id', req.query.id).eq('tenant_id', ctx.tenantId).maybeSingle();
    if (error) throw new Error('Could not load event');
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.zoom_webinar_id) return res.json({ job: null });
    if (req.method === 'POST') {
      const queued = await supabase.rpc('queue_zoom_speakers', { p_tenant: ctx.tenantId, p_webinar: event.zoom_webinar_id });
      if (queued.error) throw new Error('Speaker synchronisation database setup is unavailable');
      await runZoomSpeakerSync({ tenantId: ctx.tenantId, webinarId: event.zoom_webinar_id });
    }
    const result = await supabase.from('zoom_speaker_sync').select('status,summary,last_error,updated_at,lease_until')
      .eq('tenant_id', ctx.tenantId).eq('webinar_id', event.zoom_webinar_id).maybeSingle();
    if (result.error) throw new Error('Could not load speaker synchronisation status');
    const job = result.data;
    if (job?.status === 'running' && (!job.lease_until || Date.parse(job.lease_until) <= Date.now())) {
      job.status = 'pending';
      job.last_error = 'The previous synchronisation was interrupted. It is safe to retry.';
    }
    return res.json({ job });
  } catch (error) { return res.status(503).json({ error: error.message }); }
}
