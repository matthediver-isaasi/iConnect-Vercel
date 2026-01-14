import { getSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

async function refreshAccessToken(connection) {
  const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      refresh_token: connection.refresh_token,
      grant_type: 'refresh_token'
    })
  });

  if (!tokenResponse.ok) {
    throw new Error('Token refresh failed');
  }

  const tokens = await tokenResponse.json();
  const tokenExpiresAt = new Date(Date.now() + (tokens.expires_in * 1000)).toISOString();

  await supabase
    .from('outlook_connection')
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || connection.refresh_token,
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString()
    })
    .eq('id', connection.id);

  return tokens.access_token;
}

async function getValidAccessToken(connection) {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  
  if (expiresAt <= new Date(now.getTime() + 5 * 60 * 1000)) {
    return await refreshAccessToken(connection);
  }
  
  return connection.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessionResult = await getSession(req);
    
    if (!sessionResult || !sessionResult.data) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const session = sessionResult.data;
    if (!session.tenantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const identityId = session.identityId || session.userId || session.memberId;
    if (!identityId) {
      return res.status(401).json({ error: 'Could not determine user identity' });
    }

    const { memberId, to, cc, subject, body, bodyType = 'html', saveToSentItems = true } = req.body || {};

    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, body' });
    }

    const { data: connection, error: connError } = await supabase
      .from('outlook_connection')
      .select('*')
      .eq('tenant_id', session.tenantId)
      .eq('identity_id', identityId)
      .single();

    if (connError || !connection) {
      return res.status(400).json({ error: 'Outlook not connected' });
    }

    if (connection.status !== 'active') {
      return res.status(400).json({ error: 'Outlook connection is not active' });
    }

    let accessToken;
    try {
      accessToken = await getValidAccessToken(connection);
    } catch (err) {
      await supabase
        .from('outlook_connection')
        .update({ status: 'expired', sync_error: 'Token refresh failed' })
        .eq('id', connection.id);
      
      return res.status(400).json({ error: 'Outlook connection expired. Please reconnect.' });
    }

    const toRecipients = Array.isArray(to) 
      ? to.map(addr => ({ emailAddress: { address: addr } }))
      : [{ emailAddress: { address: to } }];

    const ccRecipients = cc 
      ? (Array.isArray(cc) 
          ? cc.map(addr => ({ emailAddress: { address: addr } }))
          : [{ emailAddress: { address: cc } }])
      : [];

    const messagePayload = {
      message: {
        subject,
        body: {
          contentType: bodyType === 'text' ? 'Text' : 'HTML',
          content: body
        },
        toRecipients,
        ccRecipients: ccRecipients.length > 0 ? ccRecipients : undefined
      },
      saveToSentItems
    };

    const sendResponse = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(messagePayload)
    });

    if (!sendResponse.ok) {
      const errorData = await sendResponse.text();
      console.error('[Outlook Send] Failed to send email:', errorData);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    if (memberId) {
      const primaryTo = Array.isArray(to) ? to[0] : to;
      
      await supabase
        .from('member_email')
        .insert({
          tenant_id: session.tenantId,
          member_id: memberId,
          microsoft_message_id: `sent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          subject,
          body_preview: body.substring(0, 255).replace(/<[^>]*>/g, ''),
          body_content: body,
          body_content_type: bodyType,
          from_address: connection.microsoft_email,
          from_name: connection.display_name,
          to_addresses: toRecipients.map(r => ({
            address: r.emailAddress.address,
            name: r.emailAddress.name
          })),
          cc_addresses: ccRecipients.map(r => ({
            address: r.emailAddress.address,
            name: r.emailAddress.name
          })),
          direction: 'outbound',
          is_read: true,
          is_draft: false,
          has_attachments: false,
          importance: 'normal',
          sent_at: new Date().toISOString(),
          synced_by_identity_id: identityId
        });

      console.log('[Outlook Send] Email logged for member:', memberId);
    }

    console.log('[Outlook Send] Email sent successfully');
    res.status(200).json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('[Outlook Send] Error:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
}
