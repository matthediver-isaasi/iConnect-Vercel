import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { resolveCampaignEventSurvey } from '../_lib/campaignEventSurvey.js';
import { resolveCampaignEventSponsors } from '../_lib/eventEmailSponsors.js';
import { getCallerEmsAccess, requireGroupAccess } from '../_lib/memberGroupEmsAccess.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const context = await getTenantContext(req);
  let allowed = context.isAuthenticated && context.tenantId && await hasAdminAccess(context);
  if (!allowed && req.body?.groupId) {
    const access = await getCallerEmsAccess(req);
    allowed = !access.error && access.tenantContext?.tenantId === context.tenantId &&
      !!requireGroupAccess(access.groups, req.body.groupId);
  }
  if (!allowed) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const campaign = {
      subject: req.body?.subject ?? '{{event_survey_url}}',
      html_content: req.body?.html_content || '',
      design_json: req.body?.design_json || null,
      event_survey_context: req.body?.event_survey_context,
    };
    const url = await resolveCampaignEventSurvey(supabase, campaign, context.tenantId);
    const sponsors = await resolveCampaignEventSponsors(supabase, campaign, context.tenantId);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ url, sponsors });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
}