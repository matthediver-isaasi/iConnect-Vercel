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
    const errorData = await tokenResponse.text();
    console.error('[Outlook Sync] Token refresh failed:', errorData);
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
    console.log('[Outlook Sync] Token expired or expiring soon, refreshing...');
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

    const { memberId } = req.body || {};

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

    let memberEmails = [];
    if (memberId) {
      const { data: member } = await supabase
        .from('member')
        .select('email')
        .eq('id', memberId)
        .eq('tenant_id', session.tenantId)
        .single();
      
      if (member?.email) {
        memberEmails = [member.email.toLowerCase()];
      }
    } else {
      const { data: members } = await supabase
        .from('member')
        .select('id, email')
        .eq('tenant_id', session.tenantId)
        .not('email', 'is', null);
      
      memberEmails = members?.map(m => ({ id: m.id, email: m.email.toLowerCase() })) || [];
    }

    if (memberEmails.length === 0) {
      return res.status(200).json({ synced: 0, message: 'No members to sync emails for' });
    }

    let totalSynced = 0;
    const syncErrors = [];

    const emailAddresses = memberId 
      ? memberEmails 
      : memberEmails.map(m => m.email);

    const searchQueries = emailAddresses.slice(0, 50).map(email => 
      typeof email === 'string' ? email : email
    );

    for (const memberInfo of (memberId ? [{ id: memberId, email: memberEmails[0] }] : memberEmails.slice(0, 50))) {
      const email = typeof memberInfo === 'string' ? memberInfo : memberInfo.email;
      const mId = typeof memberInfo === 'string' ? memberId : memberInfo.id;

      try {
        const sentFilter = `from/emailAddress/address eq '${email}' or recipients/any(r:r/emailAddress/address eq '${email}')`;
        
        const messagesUrl = new URL('https://graph.microsoft.com/v1.0/me/messages');
        messagesUrl.searchParams.set('$filter', sentFilter);
        messagesUrl.searchParams.set('$select', 'id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,isRead,isDraft,hasAttachments,importance,attachments');
        messagesUrl.searchParams.set('$top', '50');
        messagesUrl.searchParams.set('$orderby', 'receivedDateTime desc');

        const msgResponse = await fetch(messagesUrl.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!msgResponse.ok) {
          const errText = await msgResponse.text();
          console.error(`[Outlook Sync] Failed to fetch messages for ${email}:`, errText);
          syncErrors.push({ email, error: 'Failed to fetch messages' });
          continue;
        }

        const msgData = await msgResponse.json();
        const messages = msgData.value || [];

        for (const msg of messages) {
          const fromAddress = msg.from?.emailAddress?.address?.toLowerCase() || '';
          const toAddresses = msg.toRecipients?.map(r => ({
            address: r.emailAddress?.address,
            name: r.emailAddress?.name
          })) || [];
          const ccAddresses = msg.ccRecipients?.map(r => ({
            address: r.emailAddress?.address,
            name: r.emailAddress?.name
          })) || [];

          const direction = fromAddress === email ? 'inbound' : 'outbound';

          const attachments = msg.attachments?.map(a => ({
            id: a.id,
            name: a.name,
            contentType: a.contentType,
            size: a.size
          })) || [];

          const { error: upsertError } = await supabase
            .from('member_email')
            .upsert({
              tenant_id: session.tenantId,
              member_id: mId,
              microsoft_message_id: msg.id,
              conversation_id: msg.conversationId,
              internet_message_id: msg.internetMessageId,
              subject: msg.subject,
              body_preview: msg.bodyPreview,
              body_content: msg.body?.content,
              body_content_type: msg.body?.contentType?.toLowerCase() || 'html',
              from_address: fromAddress,
              from_name: msg.from?.emailAddress?.name,
              to_addresses: toAddresses,
              cc_addresses: ccAddresses,
              direction,
              is_read: msg.isRead || false,
              is_draft: msg.isDraft || false,
              has_attachments: msg.hasAttachments || false,
              importance: msg.importance?.toLowerCase() || 'normal',
              attachments,
              sent_at: msg.sentDateTime,
              received_at: msg.receivedDateTime,
              synced_by_identity_id: identityId
            }, {
              onConflict: 'tenant_id,microsoft_message_id',
              ignoreDuplicates: false
            });

          if (!upsertError) {
            totalSynced++;
          }
        }
      } catch (err) {
        console.error(`[Outlook Sync] Error syncing for ${email}:`, err);
        syncErrors.push({ email, error: err.message });
      }
    }

    await supabase
      .from('outlook_connection')
      .update({
        last_sync_at: new Date().toISOString(),
        sync_error: syncErrors.length > 0 ? JSON.stringify(syncErrors) : null
      })
      .eq('id', connection.id);

    console.log(`[Outlook Sync] Synced ${totalSynced} emails for tenant ${session.tenantId}`);

    res.status(200).json({
      synced: totalSynced,
      errors: syncErrors.length > 0 ? syncErrors : undefined,
      message: `Synced ${totalSynced} emails`
    });
  } catch (error) {
    console.error('[Outlook Sync] Error:', error);
    res.status(500).json({ error: 'Failed to sync emails' });
  }
}
