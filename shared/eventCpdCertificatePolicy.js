// Certificate selection and the displayed activity dates are independent of
// CPD points, badges and attendance. This module only resolves policy; it does
// not issue a certificate or read any database records.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

export function isValidCertificateDate(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  // Date.UTC treats years 0–99 as 1900–1999. Check leap years directly so
  // 0004-02-29 is valid but 0001-02-29 and 1900-02-29 are not.
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= days;
}

export function formatCertificateActivityDateRange(startDate, endDate = null) {
  if (!isValidCertificateDate(startDate) || (endDate != null && !isValidCertificateDate(endDate))
    || (endDate && endDate < startDate)) return null;
  const display = date => new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
  return !endDate || endDate === startDate ? display(startDate) : `${display(startDate)} – ${display(endDate)}`;
}

// Shared mapping for the designer and the future issuance path. The combined
// range is preformatted text, not a date-formatted placeholder: a PDF renderer
// must not parse or reformat a string containing two dates.
export function certificateDatePlaceholderValues(policy) {
  const start = policy?.start_date;
  const end = policy?.end_date;
  const display = date => isValidCertificateDate(date)
    ? formatCertificateActivityDateRange(date) : '';
  return {
    'cpd.activity_date': display(start),
    'cpd.activity_date_range': formatCertificateActivityDateRange(start, end) || '',
    'cpd.activity_start_date': start || '',
    'cpd.activity_end_date': end || '',
  };
}

export function emptyEventCpdCertificateConfig() {
  return {
    eventRule: { template_id: null, email_template_id: null, date_mode: 'event', start_date: null, end_date: null },
    ticketRules: {},
  };
}

function validateRange(rule, label, custom) {
  const errors = [];
  if (custom) {
    if (!isValidCertificateDate(rule?.start_date)) errors.push(`${label} start date must be a valid YYYY-MM-DD date`);
    if (rule?.end_date != null && rule.end_date !== '' && !isValidCertificateDate(rule.end_date)) {
      errors.push(`${label} end date must be a valid YYYY-MM-DD date`);
    }
    if (isValidCertificateDate(rule?.start_date) && isValidCertificateDate(rule?.end_date) && rule.end_date < rule.start_date) {
      errors.push(`${label} end date must not precede start date`);
    }
  } else if ((rule?.start_date != null && rule.start_date !== '') || (rule?.end_date != null && rule.end_date !== '')) {
    errors.push(`${label} dates must be empty unless custom dates are selected`);
  }
  return errors;
}

export function validateEventCpdCertificateConfig(config, tickets) {
  const errors = [];
  if (!config || typeof config !== 'object' || !config.eventRule || typeof config.eventRule !== 'object') {
    return ['Event-wide certificate rule is required'];
  }
  const eventRule = config.eventRule;
  if (eventRule.email_template_id != null && (typeof eventRule.email_template_id !== 'string' || !eventRule.email_template_id.trim())) {
    errors.push('Event-wide email template must be a non-empty ID or null');
  }
  if (eventRule.template_id != null && (typeof eventRule.template_id !== 'string' || !eventRule.template_id.trim())) {
    errors.push('Event-wide template must be a non-empty ID or null');
  }
  if (!['event', 'custom'].includes(eventRule.date_mode)) errors.push('Event-wide date mode must be event or custom');
  errors.push(...validateRange(eventRule, 'Event-wide', eventRule.date_mode === 'custom'));
  if (config.ticketRules != null && (typeof config.ticketRules !== 'object' || Array.isArray(config.ticketRules))) {
    errors.push('Ticket certificate rules must be keyed by ticket reference');
    return errors;
  }
  const allowedTickets = tickets && new Set(tickets.map(ticket => String(ticket._dbId || ticket.id || ticket.ticket_reference || ticket)));
  for (const [reference, rule] of Object.entries(config.ticketRules || {})) {
    const label = `Ticket ${reference}`;
    if (!reference || (allowedTickets && !allowedTickets.has(reference))) errors.push(`${label} is not a ticket on this event`);
    if (!rule || typeof rule !== 'object') { errors.push(`${label} rule is invalid`); continue; }
    if (rule.email_template_id != null) errors.push(`${label} email template selection is event-wide only`);
    if (!['inherit', 'override', 'none'].includes(rule.template_mode)) errors.push(`${label} template mode must be inherit, override or none`);
    if (rule.template_mode === 'override') {
      if (typeof rule.template_id !== 'string' || !rule.template_id.trim()) errors.push(`${label} override requires a template ID`);
    } else if (rule.template_id != null && rule.template_id !== '') errors.push(`${label} template ID must be empty unless overriding`);
    if (!['inherit', 'custom'].includes(rule.date_mode)) errors.push(`${label} date mode must be inherit or custom`);
    errors.push(...validateRange(rule, label, rule.date_mode === 'custom'));
  }
  return errors;
}

// Event timestamps with offsets are rendered in the EVENT timezone (not the
// browser/server timezone). Naive local timestamps are already event-local.
export function eventDateOnly(value, timezone = 'Europe/London') {
  if (typeof value !== 'string') return null;
  if (DATE_ONLY.test(value)) return isValidCertificateDate(value) ? value : null;
  if (LOCAL_DATE_TIME.test(value)) return isValidCertificateDate(value.slice(0, 10)) ? value.slice(0, 10) : null;
  if (!INSTANT.test(value) || !isValidCertificateDate(value.slice(0, 10)) || Number.isNaN(Date.parse(value))) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(value));
    const get = type => parts.find(part => part.type === type)?.value;
    return `${get('year')?.padStart(4, '0')}-${get('month')}-${get('day')}`;
  } catch {
    return null; // Invalid timezone must never silently use the server timezone.
  }
}

export function resolveEventCpdCertificatePolicy({ config, event, ticketReference = null, templates = [] }) {
  const errors = validateEventCpdCertificateConfig(config);
  if (errors.length) {
    return { available: false, reason: 'invalid_policy', errors, template_id: null, template: null, start_date: null, end_date: null };
  }
  const ticketRule = ticketReference == null ? null : config.ticketRules?.[String(ticketReference)];
  const templateMode = ticketRule?.template_mode || 'inherit';
  const templateId = templateMode === 'none' ? null
    : templateMode === 'override' ? ticketRule.template_id : config.eventRule.template_id;
  const templateSource = templateMode === 'inherit' ? 'event' : 'ticket';
  const dateSource = ticketRule?.date_mode === 'custom' ? 'ticket'
    : config.eventRule.date_mode === 'custom' ? 'event_custom' : 'event';
  const source = dateSource === 'ticket' ? ticketRule : config.eventRule;
  const startDate = dateSource === 'event'
    ? eventDateOnly(event?.start_date, event?.timezone || 'Europe/London') : source.start_date;
  // Missing end date is explicitly a single-day activity, not an unavailable range.
  const endDate = dateSource === 'event'
    ? (event?.end_date ? eventDateOnly(event.end_date, event?.timezone || 'Europe/London') : null)
    : (source.end_date || null);
  const template = templateId == null ? null
    : (Array.isArray(templates) ? templates : Object.values(templates || {}))
      .find(item => item.id === templateId) || null;
  const reason = !templateId ? 'no_template' : !template ? 'template_unavailable'
    : template.status !== 'active' ? 'template_inactive'
      : template.unavailable ? 'template_unavailable'
      : !startDate || (event?.end_date && dateSource === 'event' && !endDate) || (endDate && endDate < startDate)
        ? 'date_unavailable' : null;
  return {
    available: reason === null, reason,
    template_id: templateId, template, start_date: startDate, end_date: endDate,
    // A single-day range displays the start only; both fields are retained
    // independently so templates may place start and end in separate boxes.
    template_source: templateSource, date_source: dateSource,
  };
}