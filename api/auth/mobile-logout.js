import { revokeBearerSession } from '../_lib/session.js';

/**
 * Token-based logout for native/mobile clients. Revokes (deletes) the bearer
 * session referenced by the request's Authorization header. Idempotent: returns
 * success even when no token is present or the token was already revoked, so the
 * client can always clear its local credential safely.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const revoked = await revokeBearerSession(req);
    return res.json({ success: true, revoked });
  } catch (error) {
    console.error('[Mobile Logout] Error:', error);
    return res.status(500).json({ success: false, error: 'Logout failed' });
  }
}
