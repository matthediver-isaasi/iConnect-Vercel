import { supabase } from './database.js';
import { getAgentEmailsForTenant, isAgentOnlyEmail } from './agentEmails.js';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

export async function refreshAccessToken(connection) {
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

export async function getValidAccessToken(connection) {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();

  if (expiresAt <= new Date(now.getTime() + 5 * 60 * 1000)) {
    console.log('[Outlook Sync] Token expired or expiring soon, refreshing...');
    return await refreshAccessToken(connection);
  }

  return connection.access_token;
}

export async function syncEmailsForConnection(connection, tenantId, options = {}) {
  const { memberId, identityId } = options;
  const syncIdentityId = identityId || connection.identity_id;

  let accessToken;
  try {
    accessToken = await getValidAccessToken(connection);
  } catch (err) {
    await supabase
      .from('outlook_connection')
      .update({ status: 'expired', sync_error: 'Token refresh failed' })
      .eq('id', connection.id);
    throw new Error('Token refresh failed — connection marked as expired');
  }

  let memberList = [];
  if (memberId) {
    const { data: member } = await supabase
      .from('member')
      .select('id, email')
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .single();

    if (member?.email) {
      memberList = [{ id: member.id, email: member.email.toLowerCase() }];
    }
  } else {
    const { data: members } = await supabase
      .from('member')
      .select('id, email')
      .eq('tenant_id', tenantId)
      .not('email', 'is', null);

    memberList = members?.map(m => ({ id: m.id, email: m.email.toLowerCase() })) || [];
  }

  if (memberList.length === 0) {
    return { synced: 0, agentOnlySkipped: 0, errors: [] };
  }

  let totalSynced = 0;
  let agentOnlySkipped = 0;
  const syncErrors = [];

  const agentEmails = await getAgentEmailsForTenant(tenantId);

  const processLimit = memberId ? memberList.length : Math.min(memberList.length, 50);

  for (const memberInfo of memberList.slice(0, processLimit)) {
    const email = memberInfo.email;
    const mId = memberInfo.id;

    try {
      const messagesUrl = new URL('https://graph.microsoft.com/v1.0/me/messages');
      messagesUrl.searchParams.set('$search', `"${email}"`);
      messagesUrl.searchParams.set('$select', 'id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,isRead,isDraft,hasAttachments,importance');
      messagesUrl.searchParams.set('$top', '50');

      const msgResponse = await fetch(messagesUrl.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'ConsistencyLevel': 'eventual'
        }
      });

      if (!msgResponse.ok) {
        const errText = await msgResponse.text();
        console.error(`[Outlook Sync] Failed to fetch messages for ${email}:`, errText);
        syncErrors.push({ email, error: `Failed to fetch messages: ${errText.substring(0, 100)}` });
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

        if (isAgentOnlyEmail(fromAddress, toAddresses, ccAddresses, agentEmails)) {
          agentOnlySkipped++;
          continue;
        }

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
            tenant_id: tenantId,
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
            synced_by_identity_id: syncIdentityId
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

  return { synced: totalSynced, agentOnlySkipped, errors: syncErrors };
}
