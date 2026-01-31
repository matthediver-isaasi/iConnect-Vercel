import { supabase } from '../_lib/database.js';

function decodeTrackingToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const [campaignId, recipientId, linkIndex] = decoded.split(':');
    return { campaignId, recipientId, linkIndex: parseInt(linkIndex, 10) };
  } catch (err) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { t: token, url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  const decodedUrl = decodeURIComponent(url);

  if (!token) {
    return res.redirect(302, decodedUrl);
  }

  const tokenData = decodeTrackingToken(token);
  if (!tokenData) {
    return res.redirect(302, decodedUrl);
  }

  const { campaignId, recipientId, linkIndex } = tokenData;

  try {
    if (supabase && campaignId && recipientId) {
      const { data: recipient } = await supabase
        .from('email_campaign_recipient')
        .select('id, member_id, campaign_id')
        .eq('id', recipientId)
        .single();

      if (recipient) {
        const userAgent = req.headers['user-agent'] || '';
        const forwardedFor = req.headers['x-forwarded-for'];
        const ipAddress = forwardedFor 
          ? forwardedFor.split(',')[0].trim() 
          : req.socket?.remoteAddress || '';

        await supabase
          .from('email_link_click')
          .insert({
            campaign_id: campaignId,
            recipient_id: recipientId,
            member_id: recipient.member_id,
            original_url: decodedUrl,
            link_index: linkIndex,
            link_position: `link-${linkIndex}`,
            user_agent: userAgent.substring(0, 500),
            ip_address: ipAddress.substring(0, 45)
          });

        await supabase
          .from('email_campaign_recipient')
          .update({
            status: 'clicked',
            clicked_at: new Date().toISOString(),
            click_count: supabase.raw ? supabase.raw('click_count + 1') : 1
          })
          .eq('id', recipientId);

        await supabase.rpc('increment_campaign_clicks', { p_campaign_id: campaignId }).catch(() => {
          supabase
            .from('email_campaign')
            .update({ clicked_count: supabase.raw ? supabase.raw('clicked_count + 1') : 1 })
            .eq('id', campaignId)
            .then(() => {})
            .catch(() => {});
        });
      }
    }
  } catch (err) {
    console.error('[Click Tracking] Error logging click:', err);
  }

  return res.redirect(302, decodedUrl);
}
