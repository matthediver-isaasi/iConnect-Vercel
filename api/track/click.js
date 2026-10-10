import { supabase } from '../_lib/database.js';

export function decodeTrackingToken(token) {
  if (typeof token !== 'string') return null;
  const parts = Buffer.from(token, 'base64url').toString().split(':');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (parts.length !== 3 || !uuid.test(parts[0]) || !uuid.test(parts[1]) || !/^\d+$/.test(parts[2])) return null;
  const linkIndex = Number(parts[2]);
  if (!Number.isSafeInteger(linkIndex) || linkIndex > 2147483647) return null;
  return { campaignId: parts[0], recipientId: parts[1], linkIndex };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // Query parameters have already been decoded by the router.
  const { t: token, url } = req.query;
  if (typeof url !== 'string') return res.status(400).json({ error: 'Missing URL parameter' });
  try {
    // Older and newly composed emails can contain tenant-relative hrefs.
    // Use a fixed base only to validate their protocol; retain the original
    // Location so the browser resolves the path on the tracking tenant's host.
    if (!url.trim() || /[\u0000-\u001f\u007f]/.test(url) ||
      !['http:', 'https:'].includes(new URL(url, 'https://relative.invalid/').protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid destination URL' });
  }
  const tracking = decodeTrackingToken(token);
  try {
    if (supabase && tracking) {
      const { campaignId, recipientId, linkIndex } = tracking;
      const { data: recipient, error } = await supabase
        .from('email_campaign_recipient').select('id, member_id, campaign_id')
        .eq('id', recipientId).eq('campaign_id', campaignId).maybeSingle();
      if (error) throw error;
      if (recipient) {
        const forwarded = req.headers['x-forwarded-for'];
        const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || '';
        // The database records evidence and increments counters in one transaction.
        // Repeated GETs are separate observed requests, not unique human clicks.
        const { error: writeError } = await supabase.from('email_link_click').insert({
          campaign_id: campaignId, recipient_id: recipientId, member_id: recipient.member_id,
          original_url: url, link_index: linkIndex, link_position: `link-${linkIndex}`,
          user_agent: String(req.headers['user-agent'] || '').substring(0, 500),
          ip_address: ip.substring(0, 45)
        });
        if (writeError) throw writeError;
      }
    }
  } catch {
    console.error('[Click Tracking] Could not persist tracked-link request');
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, url);
}
