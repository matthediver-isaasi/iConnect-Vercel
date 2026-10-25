import { hashFormAlertToken, projectFormAlertCapability } from './formAlertCapabilities.js';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

export const FORWARD_DAYS = 7;
export const FORWARD_PUBLIC_FIELDS = 'id,submission_id,recipient_name,recipient_email,status,created_at,sent_at,expires_at,revoked_at';
export const forwardUuid = value => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const forwardError = (message, status = 400) => Object.assign(new Error(message), { status });
export const escapeForwardHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function sanitizeForwardMessage(value = '') {
  if (typeof value !== 'string' || value.length > 50000) throw forwardError('The message is too long.');
  const window = new JSDOM('').window;
  try {
    return createDOMPurify(window).sanitize(value, {
      ALLOWED_TAGS: ['p','br','strong','em','u','s','ul','ol','li','blockquote','a','h2','h3'],
      ALLOWED_ATTR: ['href','title'], ALLOW_DATA_ATTR: false,
    });
  } finally { window.close(); }
}

export function forwardDeliveryStatus(result) {
  if (result?.success === true) return 'sent';
  if (result?.ambiguousEffect === true) return 'unknown';
  if (result?.notSubmitted === true || (Number(result?.status) >= 400 && Number(result?.status) < 500)) return 'failed';
  return 'unknown';
}

export async function resolveSubmissionForward(db, tenantId, token, now = Date.now()) {
  const hash = hashFormAlertToken(token);
  if (!hash || !tenantId) return null;
  const { data, error } = await db.from('form_submission_forward').select('tenant_id,form_id,submission_id,status,expires_at,revoked_at,form_snapshot')
    .eq('tenant_id', tenantId).eq('token_hash', hash).maybeSingle();
  if (error) throw error;
  if (!data || data.status !== 'sent' || data.revoked_at
    || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= now) return null;
  return projectFormAlertCapability(db, tenantId, data);
}
