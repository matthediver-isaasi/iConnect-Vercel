import { resolveEventEmailContext } from './eventEmailContext.js';
import { resolveCampaignEventSurvey } from './campaignEventSurvey.js';
import { assignmentWindowState } from './surveyAssignment.js';
import { renderCpdEmailContent } from './eventCpdEmail.js';

const attendeePattern = () => /\{\{\s*attendee_(?:first_name|last_name|name|email)\s*\}\}|\[\[\s*attendee\.(?:first_name|last_name|email)\s*\]\]/gi;
const listPattern = () => /\{\{\s*event_survey_list\s*\}\}|\[\[\s*event_survey_list\s*\]\]/gi;
export const usesCampaignAttendeeContent = campaign =>
  attendeePattern().test(`${campaign.subject || ''}\n${campaign.html_content || ''}`) ||
  listPattern().test(`${campaign.subject || ''}\n${campaign.html_content || ''}`);

// Ordinary assignment URLs retain their existing authentication/access policy.
// Do not mint certificate credentials: those require an accepted certificate
// delivery ledger entry and must never be impersonated by a campaign send.
export async function resolveCampaignAttendeeContent(db, campaign, tenantId, recipient) {
  if (!usesCampaignAttendeeContent(campaign)) return { html: campaign.html_content || '', subject: campaign.subject || '' };
  if (!recipient?.email) throw new Error('Select a source attendee to test attendee or event survey list placeholders.');
  const context = campaign.event_survey_context;
  await resolveEventEmailContext(db, context, tenantId);
  const table = context.event_type === 'event' ? 'booking' : 'complex_event_booking';
  const { data: bookings, error } = await db.from(table)
    .select('id,attendee_first_name,attendee_last_name,attendee_email')
    .eq('tenant_id', tenantId).eq('event_id', context.event_id).eq('status', 'confirmed')
    .ilike('attendee_email', recipient.email.trim().replace(/([%_\\])/g, '\\$1'))
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw new Error('Could not validate the campaign attendee.');
  const booking = bookings?.[0];
  if (!booking) throw new Error('No confirmed attendee matches this recipient in the selected campaign event.');
  const values = {
    attendee_first_name: booking.attendee_first_name || '',
    attendee_last_name: booking.attendee_last_name || '',
    attendee_name: [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' '),
    attendee_email: booking.attendee_email || '',
  };
  let list = null;
  if (listPattern().test(`${campaign.subject || ''}\n${campaign.html_content || ''}`)) {
    const data = [];
    for (let offset = 0; ; offset += 500) {
      const { data: page, error: assignmentError } = await db.from('event_survey_assignment').select('*')
        .eq('tenant_id', tenantId).eq('event_type', context.event_type)
        .eq(context.event_type === 'event' ? 'event_id' : 'complex_event_id', context.event_id)
        .eq('status', 'active').order('id').range(offset, offset + 499);
      if (assignmentError) throw new Error('Could not load campaign event surveys.');
      data.push(...(page || []));
      if (!page || page.length < 500) break;
    }
    const links = [];
    for (const assignment of data || []) {
      if (assignmentWindowState(assignment) !== 'open') continue;
      const url = await resolveCampaignEventSurvey(db, {
        subject: '', html_content: '{{event_survey_url}}',
        event_survey_context: { ...context, assignment_id: assignment.id },
      }, tenantId);
      const { data: form, error: formError } = await db.from('form').select('name')
        .eq('tenant_id', tenantId).eq('id', assignment.form_id).maybeSingle();
      if (formError || !form) throw new Error('Could not load campaign survey title.');
      const escape = value => String(value).replace(/[&<>"'{}[\]]/g, char => `&#${char.charCodeAt(0)};`);
      links.push({ html: `<li><a href="${escape(url)}">${escape(form.name || 'Complete survey')}</a></li>`,
        text: `${form.name || 'Complete survey'}: ${url}` });
    }
    list = {
      html: links.length ? `<ul>${links.map(link => link.html).join('')}</ul>` : '<p>No surveys are currently available for this event.</p>',
      text: links.length ? links.map(link => link.text).join('\n') : 'No surveys are currently available for this event.',
    };
  }
  const render = (source, html) => String(source || '')
    .replace(attendeePattern(), token => {
      const key = token.replace(/[{}[\]\s]/g, '').replace('attendee.', 'attendee_').toLowerCase();
      return renderCpdEmailContent(`{{${key}}}`, values, html);
    })
    .replace(listPattern(), () => html ? list.html : 'Event surveys');
  return { html: render(campaign.html_content, true), subject: render(campaign.subject, false) };
}