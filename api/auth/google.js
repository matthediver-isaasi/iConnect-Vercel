import crypto from 'crypto';
import { serialize } from 'cookie';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || 'iconnect-session-secret-change-in-production';

function signState(payload) {
  const data = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, signature })).toString('base64url');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google OAuth not configured' });
  }

  try {
    const tenant = await resolveTenantFromRequest(req);
    
    if (!tenant) {
      return res.status(400).json({ error: 'Could not determine tenant from request' });
    }

    const settings = tenant.settings || {};
    if (settings.member_google_login_enabled === false) {
      return res.redirect('/login?error=google_disabled');
    }

    const nonce = crypto.randomBytes(32).toString('hex');
    
    const nonceCookie = serialize('google_oauth_nonce', nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      domain: process.env.NODE_ENV === 'production' ? '.iconn.app' : undefined,
      maxAge: 300
    });
    res.setHeader('Set-Cookie', nonceCookie);

    const host = req.headers.host || 'iconn.app';
    const protocol = req.headers['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
    
    const isProduction = process.env.NODE_ENV === 'production';
    const redirectUri = isProduction 
      ? 'https://iconn.app/api/auth/google/callback'
      : `${protocol}://${host}/api/auth/google/callback`;
    
    const statePayload = {
      nonce,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      originHost: req.headers.host,
      returnTo: req.query.returnTo || null,
      timestamp: Date.now()
    };

    const signedState = signState(statePayload);

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'select_account');
    authUrl.searchParams.set('state', signedState);

    res.redirect(authUrl.toString());
  } catch (error) {
    console.error('[Google OAuth] Error initiating auth:', error);
    res.status(500).json({ error: 'Failed to initiate Google authentication' });
  }
}
