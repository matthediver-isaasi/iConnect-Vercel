import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  DB_EVENT_TYPES, emptyCertificateConfig, loadCertificateConfig, validateCertificateConfig,
} from '../_lib/eventCpdCertificateRules.js';

const safeTemplate = ({ id, name, version, status, source_sha256 }) => ({
  id, name, version, status, source_sha256,
});

export async function handleCertificateRules(req, res, {
  db = supabase, contextFor = getTenantContext, adminAccess = hasAdminAccess,
} = {}) {
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!db) return res.status(503).json({ error: 'Database not configured' });
  const context = await contextFor(req);
  if (!context?.tenantId || !context.isAuthenticated) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await adminAccess(context))) return res.status(403).json({ error: 'Event administrator permission is required' });
  const eventType = req.method === 'GET' ? req.query?.event_type : req.body?.event_type;
  const eventId = req.method === 'GET' ? req.query?.event_id : req.body?.event_id;
  if (!DB_EVENT_TYPES[eventType]) return res.status(400).json({ error: 'event_type must be simple or complex' });
  if (req.method === 'PUT' && !eventId) return res.status(400).json({ error: 'event_id is required' });
  try {
    let event = null;
    if (eventId) {
      const result = await db.from(DB_EVENT_TYPES[eventType]).select('id,pricing_config')
        .eq('id', eventId).eq('tenant_id', context.tenantId).maybeSingle();
      if (result.error) throw result.error;
      event = result.data;
      if (!event) return res.status(404).json({ error: 'Event not found' });
    }
    const { data: active, error: listError } = await db.from('cpd_certificate_template')
      .select('id,name,version,status,source_sha256,source_path')
      .eq('tenant_id', context.tenantId).eq('status', 'active').order('name');
    if (listError) throw listError;
    const activeTemplates = (active || []).filter(template => template.source_path);
    if (req.method === 'GET') {
      const config = eventId ? await loadCertificateConfig(db, context.tenantId, eventType, eventId) : emptyCertificateConfig();
      const selectedIds = new Set([config.eventRule?.template_id,
        ...Object.values(config.ticketRules || {}).map(rule => rule?.template_id)].filter(Boolean));
      const unavailable = [];
      for (const id of selectedIds) {
        if (activeTemplates.some(template => template.id === id)) continue;
        const { data: reference, error } = await db.from('cpd_certificate_template')
          .select('id,name,version,status,source_sha256')
          .eq('tenant_id', context.tenantId).eq('id', id).maybeSingle();
        if (error) throw error;
        unavailable.push(reference
          ? { ...safeTemplate(reference), unavailable: true }
          : { id, name: 'Unavailable template', unavailable: true });
      }
      return res.status(200).json({ config, templates: [
        ...activeTemplates.map(template => ({ ...safeTemplate(template), unavailable: false })), ...unavailable,
      ] });
    }
    let ids;
    if (eventType === 'simple') {
      ids = (event.pricing_config?.ticket_classes || []).map(ticket => String(ticket.id));
    } else {
      const { data, error } = await db.from('complex_event_ticket_class').select('id')
        .eq('tenant_id', context.tenantId).eq('complex_event_id', eventId);
      if (error) throw error;
      ids = (data || []).map(ticket => String(ticket.id));
    }
    const config = validateCertificateConfig(req.body?.config, ids, activeTemplates.map(template => template.id));
    const { data, error } = await db.rpc('replace_event_cpd_certificate_config', {
      p_tenant_id: context.tenantId, p_event_type: DB_EVENT_TYPES[eventType],
      p_event_id: eventId, p_config: config,
    });
    if (error) throw error;
    return res.status(200).json({ config: data });
  } catch (error) {
    const validation = error.message?.startsWith('Invalid')
      || /^(At most|Event dates|Ticket dates|Override requires|Inherited|Certificate override|Event .*template|Ticket .*template)/.test(error.message || '')
      || (error.code === 'P0001' && /^(invalid |event does not|ticket does not|certificate template must|custom certificate|inherited certificate|missing ticket)/i.test(error.message || ''));
    if (!validation) console.error('[event-cpd-certificate-rules]', error);
    return res.status(validation ? 400 : 500).json({
      error: validation ? error.message : 'Failed to process certificate rules',
    });
  }
}

export default function handler(req, res) {
  return handleCertificateRules(req, res);
}