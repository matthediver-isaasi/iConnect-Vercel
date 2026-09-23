import { getSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { getValidMicrosoftAccessToken } from '../_lib/microsoftGraph.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { normalizeMemberEmailAddress, parseMemberEmailCc } from '../../shared/memberEmailRecipients.mjs';

const ALLOWED_FIELDS = new Set([
  'memberId', 'tenantId', 'to', 'cc', 'subject', 'body', 'bodyType', 'saveToSentItems',
]);

function isDeletedMember(member) {
  return /^deleted_.+@deleted\.local$/i.test(String(member?.email || ''));
}

export async function handleOutlookSend(req, res, dependencies = {}) {
  const database = dependencies.database || supabase;
  const loadContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const loadSession = dependencies.getSession || getSession;
  const loadAccessToken = dependencies.getValidMicrosoftAccessToken || getValidMicrosoftAccessToken;
  const request = dependencies.fetch || fetch;
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
    if (!database) return res.status(503).json({ error: 'Database not configured' });
    const context = await loadContext(req);
    if (!context?.isAuthenticated || !context.tenantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (context.tenantMismatch || !(await checkAdmin(context))) {
      return res.status(403).json({ error: 'Administrator access required' });
    }

    const sessionResult = await loadSession(req);
    
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

    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const unsupported = Object.keys(input).filter(key => !ALLOWED_FIELDS.has(key));
    if (unsupported.length) {
      return res.status(400).json({ error: `Unsupported field: ${unsupported[0]}` });
    }
    const { memberId, tenantId, to, cc, subject, body, bodyType = 'html', saveToSentItems = true } = input;

    if (typeof memberId !== 'string' || !memberId.trim()) {
      return res.status(400).json({ error: 'memberId must be a non-empty string' });
    }
    if (
      typeof tenantId !== 'string'
      || !tenantId.trim()
      || tenantId !== context.tenantId
      || tenantId !== session.tenantId
    ) {
      return res.status(403).json({ error: 'Tenant context does not match' });
    }
    if (typeof to !== 'string' || typeof subject !== 'string' || typeof body !== 'string') {
      return res.status(400).json({ error: 'to, subject, and body must be strings' });
    }
    if (!subject.trim() || !body.trim()) {
      return res.status(400).json({ error: 'Missing required fields: subject, body' });
    }
    if (/[\r\n]/.test(subject)) {
      return res.status(400).json({ error: 'Subject contains invalid header characters' });
    }
    if (!['text', 'html'].includes(bodyType) || typeof saveToSentItems !== 'boolean') {
      return res.status(400).json({ error: 'Invalid message options' });
    }

    let clientTo;
    let ccAddresses;
    try {
      clientTo = normalizeMemberEmailAddress(to);
      ccAddresses = parseMemberEmailCc(cc);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const { data: member, error: memberError } = await database
      .from('member')
      .select('id, email, tenant_id')
      .eq('id', memberId)
      .eq('tenant_id', context.tenantId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member || isDeletedMember(member)) {
      return res.status(404).json({ error: 'Member not found' });
    }
    let serverTo;
    try {
      serverTo = normalizeMemberEmailAddress(member.email);
    } catch {
      return res.status(409).json({ error: 'Member does not have a valid email address' });
    }
    if (clientTo.toLowerCase() !== serverTo.toLowerCase()) {
      return res.status(409).json({ error: 'Member email has changed; refresh before sending' });
    }

    const { data: connection, error: connError } = await database
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
      accessToken = await loadAccessToken(connection);
    } catch (err) {
      await database
        .from('outlook_connection')
        .update({ status: 'expired', sync_error: 'Token refresh failed' })
        .eq('id', connection.id);
      
      return res.status(400).json({ error: 'Outlook connection expired. Please reconnect.' });
    }

    const toRecipients = [{ emailAddress: { address: serverTo } }];
    const ccRecipients = ccAddresses.map(address => ({ emailAddress: { address } }));

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

    let sendResponse;
    try {
      sendResponse = await request('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(messagePayload)
      });
    } catch {
      console.error('[Outlook Send] Microsoft Graph delivery result is unknown');
      return res.status(502).json({
        error: 'Email delivery could not be confirmed. Do not retry until its status is verified.',
        deliveryUnknown: true,
      });
    }

    if (!sendResponse.ok) {
      console.error('[Outlook Send] Microsoft Graph rejected the message');
      return res.status(500).json({ error: 'Failed to send email' });
    }

    if (memberId) {
      let logError = null;
      try {
        const logResult = await database
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
        logError = logResult?.error || null;
      } catch {
        logError = new Error('History write failed');
      }

      if (logError) {
        console.error('[Outlook Send] Email accepted but history logging failed');
        return res.status(200).json({
          success: true,
          message: 'Email sent successfully',
          warning: 'Email was sent but could not be added to email history',
        });
      }
    }

    return res.status(200).json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('[Outlook Send] Unexpected send failure');
    return res.status(500).json({ error: 'Failed to send email' });
  }
}

export default function handler(req, res) {
  return handleOutlookSend(req, res);
}
