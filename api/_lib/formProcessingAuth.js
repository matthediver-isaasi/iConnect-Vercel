import { createHmac, timingSafeEqual } from 'node:crypto';

const HEADER = 'x-form-processing-signature';
const TIMESTAMP_HEADER = 'x-form-processing-timestamp';
const MAX_AGE_MS = 5 * 60 * 1000;

function message(timestamp, {
  tenantId,
  formId,
  submissionId,
  verifiedSubmitterMemberId,
  verifiedAdminAccess,
}) {
  const adminAssertion = verifiedAdminAccess === true ? '1' : '0';
  return `${timestamp}:${tenantId || ''}:${formId || ''}:${submissionId || ''}:${verifiedSubmitterMemberId || ''}:${adminAssertion}`;
}

export function buildFormProcessingHeaders(ids, now = Date.now()) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is required for internal form processing');
  const timestamp = String(now);
  const signature = createHmac('sha256', secret).update(message(timestamp, ids)).digest('hex');
  return { [HEADER]: signature, [TIMESTAMP_HEADER]: timestamp };
}

export function verifyFormProcessingRequest(req, ids, now = Date.now()) {
  const secret = process.env.SESSION_SECRET;
  const timestamp = String(req.headers?.[TIMESTAMP_HEADER] || '');
  const supplied = String(req.headers?.[HEADER] || '');
  const parsed = Number(timestamp);
  if (!secret || !supplied || !Number.isFinite(parsed) || Math.abs(now - parsed) > MAX_AGE_MS) return false;
  const expected = createHmac('sha256', secret).update(message(timestamp, ids)).digest('hex');
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function resolveTrustedFormProcessingAdmin({ trustedInternal, verifiedAdminAccess }) {
  return trustedInternal === true && verifiedAdminAccess === true;
}