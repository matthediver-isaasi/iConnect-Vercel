import { createHmac, timingSafeEqual } from 'node:crypto';

// Stateless page capability: never a login substitute. Re-authenticate and
// re-resolve tenant credentials on every request, including linkage pagination.
export function signPayoutScope(key, scope) {
  const body = Buffer.from(JSON.stringify({ ...scope, expires: Date.now() + 30 * 60 * 1000 })).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
export function verifyPayoutScope(key, token, tenantId, mode) {
  if (typeof token !== 'string' || token.length > 12000) throw new Error('Invalid payout scope.');
  const [body, signature, extra] = token.split('.');
  const expected = createHmac('sha256', key).update(body || '').digest();
  const actual = Buffer.from(signature || '', 'base64url');
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid payout scope.');
  const scope = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (scope.tenantId !== tenantId || scope.mode !== mode || scope.expires < Date.now()
    || !Array.isArray(scope.ids) || scope.ids.length > 20) throw new Error('Expired or mismatched payout scope.');
  return scope;
}
