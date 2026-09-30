import { getSession } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { normalizeMemberEmailAddress, parseMemberEmailCc } from '../../shared/memberEmailRecipients.mjs';

const ALLOWED_FIELDS = new Set([
  'memberId', 'tenantId', 'to', 'cc', 'subject', 'body', 'bodyType',
]);

function isDeletedMember(member) {
  return /^deleted_.+@deleted\.local$/i.test(String(member?.email || ''));
}

function senderParts(value) {
  const sender = String(value || '').trim();
  const displayAddress = sender.match(/^(.*?)\s*<([^<>]+)>$/);
  return displayAddress
    ? { address: displayAddress[2].trim(), name: displayAddress[1].trim() || null }
    : { address: sender, name: null };
}

function textToHtml(value) {
  return `<div style="white-space: pre-wrap;">${value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')}</div>`;
}

export async function handleCrmSend(req, res, dependencies = {}) {
  const database = dependencies.database || supabase;
  const loadContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const loadSession = dependencies.getSession || getSession;
  const deliver = dependencies.sendEmail || sendEmail;

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tenant-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!database) return res.status(503).json({ error: 'Database not configured' });
    const context = await loadContext(req);
    if (!context?.isAuthenticated || !context.tenantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (context.tenantMismatch || !(await checkAdmin(context))) {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    if (!req.headers?.['x-tenant-id'] || req.headers['x-tenant-id'] !== context.tenantId) {
      return res.status(403).json({ error: 'Tenant context does not match' });
    }

    const sessionResult = await loadSession(req);
    const session = sessionResult?.data;
    if (!session?.tenantId || session.tenantId !== context.tenantId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const unsupported = Object.keys(input).filter(key => !ALLOWED_FIELDS.has(key));
    if (unsupported.length) {
      return res.status(400).json({ error: `Unsupported field: ${unsupported[0]}` });
    }

    const { memberId, tenantId, to, cc, subject, body, bodyType = 'text' } = input;
    if (typeof memberId !== 'string' || !memberId.trim()) {
      return res.status(400).json({ error: 'memberId must be a non-empty string' });
    }
    if (typeof tenantId !== 'string' || !tenantId.trim()
      || tenantId !== context.tenantId || tenantId !== session.tenantId) {
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
    if (!['text', 'html'].includes(bodyType)) {
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
      return res.status(409).json({
        error: 'Member does not have a valid email address',
        code: 'STALE_MEMBER_EMAIL',
      });
    }
    if (clientTo.toLowerCase() !== serverTo.toLowerCase()) {
      return res.status(409).json({
        error: 'Member email has changed; refresh before sending',
        code: 'MEMBER_EMAIL_CHANGED',
      });
    }

    let delivery;
    try {
      delivery = await deliver({
        to: serverTo,
        cc: ccAddresses.length ? ccAddresses : undefined,
        subject: subject.trim(),
        ...(bodyType === 'html'
          ? { html: body.trim() }
          : { text: body.trim(), html: textToHtml(body.trim()) }),
        tenantId: context.tenantId,
        // CRM history must persist the exact final provider rendering. This is
        // deliberately opt-in so ordinary callers never receive message
        // content in sendEmail's result object.
        includeRenderedContent: true,
      });
    } catch {
      // Once the provider invocation starts, a thrown transport error may have
      // happened after Mailgun accepted the message. Never invite an automatic
      // or manual retry until delivery is checked.
      return res.status(502).json({
        error: 'Email delivery could not be confirmed. Do not retry until its status is verified.',
        code: 'MAILGUN_DELIVERY_UNKNOWN',
        deliveryUnknown: true,
        provider: {
          provider: 'mailgun',
          messageId: null,
          domain: null,
          fromAddress: null,
          fallback: false,
        },
      });
    }
    const provider = {
      provider: delivery.provider || 'mailgun',
      messageId: delivery.messageId || null,
      domain: delivery.domain || null,
      fromAddress: delivery.fromAddress || null,
      fallback: delivery.fallback === true,
    };

    if (!delivery.success) {
      const deliveryUnknown = delivery.ambiguousEffect === true;
      return res.status(502).json({
        error: deliveryUnknown
          ? 'Email delivery could not be confirmed. Do not retry until its status is verified.'
          : 'Email provider rejected the message',
        code: deliveryUnknown ? 'MAILGUN_DELIVERY_UNKNOWN' : 'MAILGUN_REJECTED',
        deliveryUnknown,
        provider,
      });
    }

    const sender = senderParts(delivery.fromAddress);
    const historySubject = typeof delivery.renderedSubject === 'string'
      ? delivery.renderedSubject
      : subject.trim();
    const historyBody = typeof delivery.renderedHtml === 'string'
      ? delivery.renderedHtml
      : body.trim();
    const historyPreviewSource = typeof delivery.renderedText === 'string'
      ? delivery.renderedText
      : historyBody.replace(/<[^>]*>/g, '');
    let logError = null;
    try {
      const logResult = await database.from('member_email').insert({
        tenant_id: context.tenantId,
        member_id: memberId,
        microsoft_message_id: null,
        email_provider: provider.provider,
        provider_message_id: delivery.messageId,
        subject: historySubject,
        body_preview: historyPreviewSource.substring(0, 255),
        body_content: historyBody,
        body_content_type: 'html',
        from_address: sender.address,
        from_name: sender.name,
        to_addresses: [{ address: serverTo, name: null }],
        cc_addresses: ccAddresses.map(address => ({ address, name: null })),
        direction: 'outbound',
        is_read: true,
        is_draft: false,
        has_attachments: false,
        importance: 'normal',
        sent_at: new Date().toISOString(),
        // This is an Outlook-sync attribution field. A direct Mailgun send was
        // not synced by an Outlook identity, so leave it unset rather than
        // substituting an identity, tenant-user, or member ID.
        synced_by_identity_id: null,
      });
      logError = logResult?.error || null;
    } catch {
      logError = new Error('History write failed');
    }

    if (logError) {
      console.error('[CRM Send] Email accepted but history logging failed');
      return res.status(200).json({
        success: true,
        message: 'Email sent successfully',
        warning: 'Email was sent but could not be added to email history',
        deliveryUnknown: false,
        provider,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Email sent successfully',
      deliveryUnknown: false,
      provider,
    });
  } catch {
    console.error('[CRM Send] Unexpected send failure');
    return res.status(500).json({ error: 'Failed to send email', deliveryUnknown: false });
  }
}

export default function handler(req, res) {
  return handleCrmSend(req, res);
}