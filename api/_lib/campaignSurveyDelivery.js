import { resolveCampaignEventSurvey, usesEventSurvey, replaceEventSurvey } from './campaignEventSurvey.js';
import { resolveEventEmailContext } from './eventEmailContext.js';
import { prepareCertificateSurveyLinks } from './certificateSurveyGrants.js';

const listPattern = () => /\{\{\s*event_survey_list\s*\}\}|\[\[\s*event_survey_list\s*\]\]/gi;
const checked = result => {
  if (result.error) throw new Error('Could not persist campaign survey delivery.');
  return result.data;
};

// Bearers may only be whole anchor destinations or standalone visible text.
// Never expand one inside an image/CSS URL or a prefixed third-party href.
export function replaceCampaignSurveyInvitation(source, url) {
  return String(source || '').replace(/\{\{\s*event_survey_url\s*\}\}|\[\[\s*event\.survey_url\s*\]\]/gi,
    (token, offset, text) => {
      const before = text.slice(0, offset);
      const after = text.slice(offset + token.length);
      // Check raw/foreign content before interpreting apparent tags inside it.
      const opening = before.match(/<(style|script|textarea|svg|math)\b[^>]*>(?:(?!<\/\1>)[\s\S])*$/i);
      if (opening) return 'Survey link unavailable';
      const tagStart = before.lastIndexOf('<');
      const inTag = tagStart > before.lastIndexOf('>');
      if (inTag) {
        const prefix = before.slice(tagStart);
        const match = prefix.match(/^<a(?:\s+[a-z][a-z0-9:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s+href\s*=\s*(["'])$/i);
        return match && after.startsWith(match[1]) ? url : '#';
      }
      return /(?:^|[\s>])$/.test(before) && /^(?:$|[\s<.,;!?])/.test(after)
        ? url : 'Survey link unavailable';
    });
}

// The destination is transport-only. The confirmed source attendee owns every
// entitlement, including administrator source-recipient test deliveries.
export async function prepareCampaignSurveyDelivery({ db, campaign, tenantId, recipient, destination, test = false }) {
  const hasList = listPattern().test(`${campaign.html_content || ''}\n${campaign.subject || ''}`);
  const hasUrl = usesEventSurvey(campaign);
  if (!hasList && !hasUrl) return null;
  const context = campaign.event_survey_context;
  await resolveEventEmailContext(db, context, tenantId);
  const ordinaryUrl = hasUrl ? await resolveCampaignEventSurvey(db, campaign, tenantId) : null;
  const bookingSource = context.event_type === 'event' ? 'standard' : 'complex';
  if (!recipient?.email) throw new Error('A source attendee is required for campaign survey invitations.');
  const bookings = checked(await db.from(bookingSource === 'standard' ? 'booking' : 'complex_event_booking')
    .select('id,attendee_email').eq('tenant_id', tenantId).eq('event_id', context.event_id)
    .eq('status', 'confirmed')
    .ilike('attendee_email', recipient.email.trim().replace(/([%_\\])/g, '\\$1'))
    .order('created_at', { ascending: false }).limit(1));
  const booking = bookings?.[0];
  if (!booking) throw new Error('No confirmed attendee matches the selected campaign event.');
  if (!test) {
    const previous = checked(await db.from('campaign_survey_delivery').select('id,status')
      .eq('tenant_id', tenantId).eq('campaign_id', campaign.id)
      .eq('campaign_recipient_id', recipient.id).in('status', ['pending', 'accepted']).maybeSingle());
    if (previous?.status === 'accepted') return { alreadyAccepted: true, deliveryId: previous.id };
    if (previous) throw new Error('Campaign survey delivery acceptance is unresolved; reconcile before retrying.');
  }
  const tenant = checked(await db.from('tenant').select('id,slug,domain').eq('id', tenantId).single());
  const delivery = checked(await db.from('campaign_survey_delivery').insert({
    tenant_id: tenantId, campaign_id: campaign.id,
    campaign_recipient_id: test ? null : recipient.id,
    purpose: test ? 'test' : 'live', booking_source: bookingSource,
    booking_id: booking.id, source_email: booking.attendee_email.trim().toLowerCase(),
    destination_email: destination, event_type: context.event_type, event_id: context.event_id,
  }).select('id').single());
  try {
    const links = await prepareCertificateSurveyLinks({
      db, tenant, eventType: context.event_type, eventId: context.event_id,
      bookingSource, bookingId: booking.id, recipient: booking.attendee_email,
      preview: false, deliveryId: delivery.id, deliveryKind: 'campaign',
      assignmentId: hasList ? null : context.assignment_id || null,
    });
    const selected = ordinaryUrl && links.links?.find(link =>
      link.assignmentUrl === ordinaryUrl);
    if (hasUrl && !selected) throw new Error('The selected campaign survey is no longer available.');
    // A completed entitlement is deliberately not reopened by a resend.
    const url = selected?.url || '#';
    let html = String(campaign.html_content || '').replace(listPattern(), () => links.html);
    if (hasUrl) html = replaceCampaignSurveyInvitation(html, url);
    const subject = replaceEventSurvey(String(campaign.subject || '').replace(listPattern(), 'Event surveys'), 'Event survey');
    return { html, subject, deliveryId: delivery.id };
  } catch (error) {
    await finishCampaignSurveyDelivery(db, delivery.id, false);
    throw error;
  }
}

export async function finishCampaignSurveyDelivery(db, deliveryId, accepted) {
  if (!deliveryId) return;
  checked(await db.from('campaign_survey_delivery')
    .update({ status: accepted ? 'accepted' : 'failed', resolved_at: new Date().toISOString() })
    .eq('id', deliveryId).eq('status', 'pending'));
}