import { replacePlaceholders, isPreferencePlaceholder } from './emailPlaceholderCore.js';
import { EVENT_CPD_EMAIL_PLACEHOLDERS } from '../../shared/eventCpdEmailPlaceholders.js';

const supported = new Set(EVENT_CPD_EMAIL_PLACEHOLDERS.map(entry => entry.token.slice(2, -2)));
const validAddress = value => typeof value === 'string' && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value) && value.length <= 254;
const escapeHtml = value => String(value).replace(/[&<>"'{}[\]]/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;', '[': '&#91;', ']': '&#93;' }[char]));

// Replace each authored token once using the shared renderer. Never rescan
// attendee data as template instructions (especially preference-link tokens).
export function renderCpdEmailContent(source, values, html = false, trustedSurveyList = null) {
  return String(source || '').replace(/\{\{\s*([^{}]+?)\s*\}\}|\[\[\s*([^[\]]+?)\s*\]\]/g, (token, curly, square) => {
    const key = curly || square;
    if (curly && isPreferencePlaceholder(key)) return `{{${key}}}`;
    if (!supported.has(key)) return '';
    if (key === 'event_survey_list') {
      return html ? (trustedSurveyList?.html || 'No surveys are currently available for this event.')
        : (trustedSurveyList?.text || 'No surveys are currently available for this event.');
    }
    const value = String(values[key] ?? '');
    if (!value) return '';
    const safe = html ? escapeHtml(value) : value.replace(/[{}[\]]/g, '');
    return replacePlaceholders(`{{${key}}}`, 'cpd_email', { [key]: safe });
  });
}

export async function loadCpdEmailTemplate(db, tenantId, id) {
  if (!id) return { template: null, reason: null };
  const { data, error } = await db.from('email_template').select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data || data.is_active !== true || data.category !== 'events') {
    return { template: null, reason: 'The selected CPD email template is unavailable or inactive. Ask an event administrator to select an active Events email template in the event CPD settings.' };
  }
  if (!data.subject?.trim() || !data.body?.trim()) return { template: data, reason: 'The selected CPD email template needs a subject and body. Ask an administrator to update it.' };
  return { template: data, reason: null };
}

export async function prepareCpdEmail(db, tenantId, selection, values, surveyList = null) {
  const template = selection.template;
  if (selection.reason) return { reason: selection.reason };
  if (!template) {
    return { message: {
      subject: `Your CPD certificate: ${values.event_name.replace(/[\r\n]/g, ' ')}`,
      text: `Dear ${values.attendee_name},\n\nPlease find your CPD certificate for ${values.event_name} attached.`,
      html: `<p>Dear ${escapeHtml(values.attendee_name)},</p><p>Please find your CPD certificate for ${escapeHtml(values.event_name)} attached.</p>`,
      resolveTransactionalPreferences: false,
    }, provenance: { default: true, version: 1 } };
  }
  const { data: tenant, error } = await db.from('tenant').select('id,name,settings').eq('id', tenantId).maybeSingle();
  if (error) throw error;
  const config = tenant?.settings?.email_domain;
  const domain = config?.status === 'verified' ? config.domain : `mail.${process.env.APP_DOMAIN || 'iconn.app'}`;
  const email = template.from_email?.trim();
  const replyTo = template.reply_to?.trim();
  if (email && (!validAddress(email) || email.split('@')[1].toLowerCase() !== domain?.toLowerCase())) {
    return { reason: 'The CPD email sender must use the tenant verified sending domain (or its platform default). Ask an administrator to correct the template sender.' };
  }
  if (replyTo && !validAddress(replyTo)) return { reason: 'The CPD email template Reply-To address is invalid. Ask an administrator to correct it.' };
  const name = template.from_name?.trim();
  if (name && /[\r\n<>]/.test(name)) return { reason: 'The CPD email sender name is invalid. Ask an administrator to correct it.' };
  const fromEmail = email || (config?.status === 'verified' ? config.from_email || `noreply@${domain}` : `noreply@${domain}`);
  const from = name && fromEmail ? `"${name.replace(/["\\]/g, '')}" <${fromEmail}>` : email || undefined;
  const subject = renderCpdEmailContent(template.subject, values, false,
    { text: 'Event surveys' }).replace(/[\r\n]/g, ' ');
  const html = renderCpdEmailContent(template.body, values, true, surveyList);
  const text = renderCpdEmailContent(template.body.replace(/<[^>]*>/g, ' '), values, false, surveyList)
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
  if (!subject.trim() || !html.trim()) return { reason: 'The selected CPD email template renders an empty subject or body. Ask an administrator to correct it.' };
  return { message: { subject, html, text, from, replyTo: replyTo || undefined, resolveTransactionalPreferences: true },
    provenance: { template_id: template.id, template_name: template.name,
      subject: template.subject, body: template.body, from_name: template.from_name,
      from_email: template.from_email, reply_to: template.reply_to,
      updated_at: template.updated_at, sender_domain: domain } };
}