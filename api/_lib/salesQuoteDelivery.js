import crypto from 'crypto';
import { sendEmail } from './emailService.js';
import { SalesHttpError } from './salesAccess.js';
import { sanitizeHostname } from './publicBaseUrl.js';

export const hashQuoteToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export function canonicalQuoteBaseUrl(tenant) {
  const domain = sanitizeHostname(tenant?.domain);
  if (domain) return `https://${domain}`;
  const slug = String(tenant?.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new SalesHttpError(500, 'Tenant has no safe public quote domain');
  }
  return `https://${slug}.iconn.app`;
}

export function quotePublicUrl(token, baseUrl) {
  if (!token || !baseUrl) throw new Error('A token and trusted tenant base URL are required');
  let parsed;
  try { parsed = new URL(String(baseUrl)); } catch { throw new Error('A safe tenant base URL is required'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || parsed.pathname !== '/' || parsed.search || parsed.hash || !sanitizeHostname(parsed.hostname)) {
    throw new Error('A safe tenant base URL is required');
  }
  return `${parsed.origin}/quote/${encodeURIComponent(token)}`;
}

export async function mintQuoteToken(db, { tenantId, quoteId, versionId, recipient, actorId, expiresAt }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const row = {
    tenant_id: tenantId, quote_id: quoteId, quote_version_id: versionId,
    token_hash: `\\x${hashQuoteToken(token)}`, recipient_email: recipient || null,
    expires_at: expiresAt, created_by: actorId,
  };
  const { data, error } = await db.from('sales_quote_delivery_token').insert(row).select('id').single();
  if (error) throw error;
  return { token, tokenId: data.id };
}

export async function sendQuote(db, input) {
  const { quote, version, tenant, actor, recipient, attachPdf, pdf, expiresInDays, baseUrl } = input;
  const deliver = input.sendEmail || sendEmail;
  if (!['issued', 'sent'].includes(version.status)) throw new SalesHttpError(409, 'Only an issued quote can be sent');
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    throw new SalesHttpError(400, 'expiresInDays must be an integer between 1 and 90');
  }
  const requestedExpiry = Date.now() + expiresInDays * 86400000;
  const validUntil = version.valid_until ? new Date(version.valid_until).getTime() : Infinity;
  const expiresAt = new Date(Math.min(requestedExpiry, validUntil)).toISOString();
  if (new Date(expiresAt) <= new Date()) throw new SalesHttpError(409, 'Quote has expired');
  const minted = await mintQuoteToken(db, {
    tenantId: quote.tenant_id, quoteId: quote.id, versionId: version.id,
    recipient, actorId: actor.actorId, expiresAt,
  });
  const url = quotePublicUrl(minted.token, baseUrl);
  const baseAudit = { tenant_id: quote.tenant_id, quote_id: quote.id, quote_version_id: version.id,
    token_id: minted.tokenId, recipient_email: recipient, actor_id: actor.actorId };
  const revokeInactive = async () => {
    const { error } = await db.from('sales_quote_delivery_token').update({
      revoked_at: new Date().toISOString(), revoked_by: actor.actorId,
    }).eq('id', minted.tokenId).is('activated_at', null);
    if (error) throw error;
  };
  const { error: attemptError } = await db.from('sales_quote_delivery_audit')
    .insert({ ...baseAudit, event_type: 'send_attempt' });
  if (attemptError) { await revokeInactive(); throw attemptError; }
  const escapedUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  let result;
  try {
    result = await deliver({
      to: recipient, tenantId: quote.tenant_id,
      subject: `Quote ${quote.quote_number}`,
      html: `<p>Please review quote <strong>${quote.quote_number}</strong>.</p><p><a href="${escapedUrl}">View and respond to quote</a></p>`,
      text: `Please review quote ${quote.quote_number}: ${url}`,
      attachments: attachPdf ? [{ filename: `${quote.quote_number}.pdf`, data: pdf, contentType: 'application/pdf' }] : null,
    });
  } catch (error) {
    result = { success: false, error: error?.message || 'Email provider failed' };
  }
  const { error: outcomeError } = await db.from('sales_quote_delivery_audit').insert({
    ...baseAudit, event_type: result.success ? 'sent' : 'send_failed',
    sender_domain: result.domain || null, provider_message_id: result.messageId || null,
    error_message: result.success ? null : result.error,
  });
  if (outcomeError || !result.success) {
    await revokeInactive();
    if (outcomeError) throw outcomeError;
    throw new SalesHttpError(502, `Quote email failed: ${result.error}`);
  }
  const { error: activateError } = await db.from('sales_quote_delivery_token').update({
    activated_at: new Date().toISOString(),
  }).eq('id', minted.tokenId).is('activated_at', null);
  if (activateError) { await revokeInactive(); throw activateError; }
  let transitionFailed = false;
  if (version.status === 'issued') {
    const { error } = await db.rpc('transition_sales_quote', {
      p_tenant_id: quote.tenant_id, p_quote_id: quote.id,
      p_expected_version: quote.row_version, p_status: 'sent',
      p_note: `Sent to ${recipient}`, p_actor_id: actor.actorId, p_actor_type: actor.actorType,
    });
    if (error) {
      transitionFailed = true;
      // Delivery succeeded and the bearer is active; this is operational
      // reconciliation, not an email failure.
      await db.from('sales_quote_delivery_audit').insert({
        ...baseAudit, event_type: 'send_transition_failed', error_message: error.message,
      });
    }
  }
  return { sent: true, expiresAt, domain: result.domain, fallback: Boolean(result.fallback), transitionFailed };
}