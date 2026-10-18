import { SalesHttpError } from './salesAccess.js';
import { canonicalQuoteBaseUrl, validateQuoteEmail } from './salesQuoteDelivery.js';
import { sendEmail } from './emailService.js';
import { getSalesAgreement, hasSalesAgreement } from './salesAgreement.js';

const checked = result => { if (result.error) throw result.error; return result.data; };
const field = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new SalesHttpError(400, `${label} is required (maximum 200 characters)`);
  return value.trim();
};
export function signingRequestDto(row, actor, quote, envelope) {
  const version = quote.versions.find(item => item.id === row.quote_version_id);
  const status = envelope?.sender_actor_id === row.sender_actor_id && envelope?.sender_actor_type === row.sender_actor_type
    ? 'signed' : !version || version.version_number !== quote.current_version ? 'superseded'
    : new Date(row.expires_at) <= new Date() ? 'expired' : row.status;
  return { id: row.id, version: version?.version_number, status, notificationStatus: row.notification_status,
    senderKey: `${row.sender_actor_type}:${row.sender_actor_id}`, senderName: row.sender_name,
    senderEmail: row.sender_email, draft: row.draft, createdAt: row.created_at, expiresAt: row.expires_at,
    canSign: status === 'pending' && !envelope && row.sender_actor_id === actor.actorId && row.sender_actor_type === actor.actorType };
}
export async function listSigningRequests(db, quote, actor) {
  const rows = checked(await db.from('sales_agreement_signing_request').select('*')
    .eq('tenant_id', actor.tenantId).eq('quote_id', quote.id).order('created_at', { ascending: false }).limit(100));
  const envelope = hasSalesAgreement(quote.currentVersion) ? await getSalesAgreement(db, quote.currentVersion.id) : null;
  return { items: (rows || []).map(row => signingRequestDto(row, actor, quote, envelope)) };
}
export async function validateSigningRequest(db, id, quote, version, actor) {
  if (!id) return null;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new SalesHttpError(400, 'Invalid signing request');
  const row = checked(await db.from('sales_agreement_signing_request').select('*')
    .eq('tenant_id', actor.tenantId).eq('quote_id', quote.id).eq('id', id).maybeSingle());
  if (!row) throw new SalesHttpError(404, 'Signing request not found');
  if (row.sender_actor_id !== actor.actorId || row.sender_actor_type !== actor.actorType) throw new SalesHttpError(403, 'Only the requested colleague can sign this request');
  if (row.quote_version_id !== version.id || version.version_number !== quote.current_version
    || new Date(row.expires_at) <= new Date()) throw new SalesHttpError(409, 'Signing request expired or was superseded');
  return row;
}
export async function requestSalesAgreementSignature(db, { quote, version, actor, sender, tenant, body }, dependencies = {}) {
  if (!hasSalesAgreement(version)) throw new SalesHttpError(400, 'This quote does not contain an agreement');
  if (sender.id === actor.actorId && sender.kind === actor.actorType) throw new SalesHttpError(400, 'Sign the agreement yourself instead of requesting your own signature');
  if (await getSalesAgreement(db, version.id)) throw new SalesHttpError(409, 'This agreement already has a frozen sender signature');
  const recipient = field(body.recipient, 'Customer email').toLowerCase();
  const contactEmail = field(body.contactEmail, 'Customer email').toLowerCase();
  if (recipient !== contactEmail) throw new SalesHttpError(400, 'Contact email must match recipient');
  const draft = { senderKey: sender.key, recipient, contactEmail,
    contactName: field(body.contactName, 'Customer name'), contactRole: field(body.contactRole, 'Customer role'),
    personalMessage: body.personalMessage || '', expiresInDays: Number(body.expiresInDays || 30),
    attachPdf: body.attachPdf !== false, version: version.version_number };
  validateQuoteEmail({ ...draft, version });
  const { data, error } = await db.rpc('request_sales_agreement_signature', {
    p_tenant_id: actor.tenantId, p_quote_id: quote.id, p_version_id: version.id,
    p_requester_id: actor.actorId, p_requester_type: actor.actorType,
    p_sender_id: sender.id, p_sender_type: sender.kind, p_sender_name: sender.name,
    p_sender_email: sender.email, p_draft: draft,
  });
  if (error) {
    if (error.code === '54000') throw new SalesHttpError(429, 'Please wait before requesting another colleague signature');
    if (error.code === '22023' || error.code === '23514') throw new SalesHttpError(409, error.message);
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const baseUrl = (dependencies.canonicalQuoteBaseUrl || canonicalQuoteBaseUrl)(tenant);
  const url = `${baseUrl}/sales/quotes/${encodeURIComponent(quote.id)}?signingRequest=${encodeURIComponent(row.id)}`;
  let sent;
  try {
    sent = await (dependencies.sendEmail || sendEmail)({ tenantId: actor.tenantId, to: sender.email,
      subject: 'Your signature is requested on a Sales agreement',
      text: `Please sign in to review and sign the Sales agreement. You must sign personally; no signature has been applied on your behalf.\n\n${url}`,
      html: `<p>Please sign in to review and sign the Sales agreement. You must sign personally; no signature has been applied on your behalf.</p><p><a href="${url}">Review signing request</a></p>` });
  } catch { sent = { success: false }; }
  const status = sent?.success ? 'sent' : 'failed';
  checked(await db.from('sales_agreement_signing_request').update({ notification_status: status,
    notified_at: sent?.success ? new Date().toISOString() : null }).eq('id', row.id).eq('tenant_id', actor.tenantId));
  if (!sent?.success) {
    const failure = new SalesHttpError(502, 'Signing request saved, but colleague notification failed. Retry after one minute.');
    failure.details = { requestId: row.id, notificationStatus: 'failed' }; throw failure;
  }
  return { request: signingRequestDto({ ...row, notification_status: status }, actor, quote, null) };
}
