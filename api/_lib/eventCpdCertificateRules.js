import {
  emptyEventCpdCertificateConfig, resolveEventCpdCertificatePolicy,
  validateEventCpdCertificateConfig,
  certificateDatePlaceholderValues as certificateActivityDateValues,
} from '../../shared/eventCpdCertificatePolicy.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DB_EVENT_TYPES = { simple: 'event', complex: 'complex_event' };
export const emptyCertificateConfig = emptyEventCpdCertificateConfig;

function checkDate(value, label) {
  if (value === null) return;
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
}

function checkRange(start, end, label) {
  checkDate(start, `${label} start_date`);
  checkDate(end, `${label} end_date`);
  if (start && end && start > end) throw new Error(`${label} end_date must not precede start_date`);
}

export function validateCertificateConfig(config, ticketIds = [], activeTemplateIds = [], activeEmailTemplateIds = []) {
  const errors = validateEventCpdCertificateConfig(config, ticketIds);
  if (errors.length) throw new Error(`Invalid certificate configuration: ${errors[0]}`);
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || !config.eventRule || typeof config.eventRule !== 'object'
    || !config.ticketRules || typeof config.ticketRules !== 'object' || Array.isArray(config.ticketRules)) {
    throw new Error('Invalid certificate configuration');
  }
  const event = config.eventRule;
  if (event.email_template_id != null
    && (!UUID.test(event.email_template_id) || !activeEmailTemplateIds.includes(event.email_template_id))) {
    throw new Error('Invalid email template: select an active Events email template in this tenant with a subject and body');
  }
  const ids = new Set(ticketIds.map(String));
  const templates = new Set(activeTemplateIds.map(String));
  const validTemplate = (id, label) => {
    if (id !== null && (!UUID.test(String(id)) || !templates.has(String(id)))) {
      throw new Error(`${label} template must be an active template in this tenant`);
    }
  };
  if (!['event', 'custom'].includes(event.date_mode)) throw new Error('Invalid event certificate date mode');
  validTemplate(event.template_id, 'Event');
  checkRange(event.start_date, event.end_date, 'Event');
  if (event.date_mode === 'event' && (event.start_date !== null || event.end_date !== null)) {
    throw new Error('Event dates must be empty when using event dates');
  }
  if (Object.keys(config.ticketRules).length > 500) throw new Error('At most 500 ticket overrides are allowed');
  for (const [id, rule] of Object.entries(config.ticketRules)) {
    if (!ids.has(id)) throw new Error('Certificate override references a ticket outside this event');
    if (!rule || !['inherit', 'override', 'none'].includes(rule.template_mode)
      || !['inherit', 'custom'].includes(rule.date_mode)) throw new Error('Invalid ticket certificate override');
    if (rule.template_mode === 'override') {
      if (!rule.template_id) throw new Error('Override requires a template');
      validTemplate(rule.template_id, 'Ticket');
    } else if (rule.template_id !== null) throw new Error('Inherited or disabled template must be empty');
    checkRange(rule.start_date, rule.end_date, 'Ticket');
    if (rule.date_mode === 'inherit' && (rule.start_date !== null || rule.end_date !== null)) {
      throw new Error('Ticket dates must be empty when inheriting dates');
    }
  }
  return config;
}

export async function loadCertificateConfig(db, tenantId, eventType, eventId) {
  const { data, error } = await db.from('event_cpd_certificate_config').select('config')
    .eq('tenant_id', tenantId).eq('event_type', DB_EVENT_TYPES[eventType]).eq('event_id', eventId).maybeSingle();
  if (error) throw error;
  return data?.config || emptyCertificateConfig();
}

export async function resolveEventCpdCertificate(db, { tenantId, eventType, eventId, ticketId }) {
  if (!DB_EVENT_TYPES[eventType]) throw new Error('Invalid event type');
  const table = eventType === 'complex' ? 'complex_event' : 'event';
  const { data: event, error } = await db.from(table).select(eventType === 'simple'
    ? 'id,start_date,end_date,timezone,pricing_config' : 'id,start_date,end_date,timezone')
    .eq('tenant_id', tenantId).eq('id', eventId).maybeSingle();
  if (error) throw error;
  if (!event) throw new Error('Event not found');
  if (ticketId != null) {
    if (eventType === 'simple') {
      if (!(event.pricing_config?.ticket_classes || []).some(ticket => String(ticket.id) === String(ticketId))) {
        throw new Error('Ticket does not belong to event');
      }
    } else {
      const result = await db.from('complex_event_ticket_class').select('id')
        .eq('tenant_id', tenantId).eq('complex_event_id', eventId).eq('id', ticketId).maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) throw new Error('Ticket does not belong to event');
    }
  }
  const config = await loadCertificateConfig(db, tenantId, eventType, eventId);
  const templateId = config.ticketRules?.[String(ticketId)]?.template_mode === 'override'
    ? config.ticketRules[String(ticketId)].template_id : config.eventRule?.template_id;
  let template = null;
  if (templateId) {
    const result = await db.from('cpd_certificate_template').select('id,name,version,status,source_sha256,source_path')
      .eq('tenant_id', tenantId).eq('id', templateId).maybeSingle();
    if (result.error) throw result.error;
    template = result.data;
  }
  const policy = resolveEventCpdCertificatePolicy({ config, event: {
    ...event, start_date: event.start_date instanceof Date ? event.start_date.toISOString() : event.start_date,
    end_date: event.end_date instanceof Date ? event.end_date.toISOString() : event.end_date,
  }, ticketReference: ticketId, templates: template ? [template] : [] });
  const available = policy.available && Boolean(policy.template?.source_path);
  return {
    ...policy,
    email_template_id: config.eventRule?.email_template_id ?? null,
    email_selection_missing: !Object.hasOwn(config.eventRule || {}, 'email_template_id'),
    available,
    reason: policy.available && !available ? 'template_unavailable' : policy.reason,
    template: undefined,
    template_version: policy.template?.version ?? null,
    template_name: policy.template?.name ?? null,
    template_source_sha256: policy.template?.source_sha256 ?? null,
    template_source_path: policy.template?.source_path ?? null,
    placeholders: certificateActivityDateValues(policy),
    provenance: {
      tenant_id: tenantId, event_type: eventType, event_id: eventId,
      ticket_reference: ticketId == null ? null : String(ticketId),
      template_id: policy.template_id, template_version: policy.template?.version ?? null,
      template_source_sha256: policy.template?.source_sha256 ?? null,
      template: policy.template_source, dates: policy.date_source,
    },
  };
}