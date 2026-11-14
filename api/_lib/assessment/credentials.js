import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// Raw credentials are returned only to the issuer/HTTP cookie writer. Never
// include them in audit changes, logs, URLs with query strings, or query keys.
export function newCredential() { return randomBytes(32).toString('base64url'); }
export function credentialHash(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}
export function matchesCredential(token, hash) {
  const actual = credentialHash(token);
  return Boolean(actual && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(hash, 'hex')));
}
export const JUDGING_COOKIE = '__Host-iconnect-judging';
export function judgingCookie(token, expiresAt) {
  if (!credentialHash(token)) throw new Error('Invalid judging session token');
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw new Error('Invalid judging session expiry');
  return `${JUDGING_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=${expiry.toUTCString()}`;
}
export function readJudgingCookie(req) {
  const cookies = String(req.headers?.cookie || '').split(';').map(s => s.trim())
    .filter(s => s.startsWith(`${JUDGING_COOKIE}=`));
  if (cookies.length !== 1) return null;
  const token = cookies[0].slice(JUDGING_COOKIE.length + 1);
  return credentialHash(token) ? token : null;
}
export function checkJudgingCsrf(req, expectedHash) {
  return req.headers?.['sec-fetch-site'] !== 'cross-site'
    && String(req.headers?.['content-type'] || '').startsWith('application/json')
    && matchesCredential(req.headers?.['x-judging-csrf'], expectedHash);
}
