import crypto from 'crypto';
import { serialize } from 'cookie';
import { getSession } from './_lib/session.js';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || 'iconnect-session-secret-change-in-production';

const MICROSOFT_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read'
].join(' ');

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

  if (!MICROSOFT_CLIENT_ID) {
    return res.status(500).json({ error: 'Microsoft OAuth not configured - missing MICROSOFT_CLIENT_ID' });
  }

  try {
    const sessionResult = await getSession(req);
    
    if (!sessionResult || !sessionResult.data) {
      return res.status(401).json({ error: 'You must be logged in to connect Outlook' });
    }

    const session = sessionResult.data;
    if (!session.tenantId) {
      return res.status(401).json({ error: 'You must be logged in to connect Outlook' });
    }

    const identityId = session.identityId || session.userId || session.memberId;
    if (!identityId) {
      return res.status(401).json({ error: 'Could not determine user identity' });
    }

    const nonce = crypto.randomBytes(32).toString('hex');
    
    const nonceCookie = serialize('outlook_oauth_nonce', nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      domain: process.env.NODE_ENV === 'production' ? '.iconn.app' : undefined,
      maxAge: 600
    });
    res.setHeader('Set-Cookie', nonceCookie);

    const isProduction = process.env.NODE_ENV === 'production';
    const redirectUri = isProduction 
      ? 'https://iconn.app/api/auth/outlook/callback'
      : `http://${req.headers.host}/api/auth/outlook/callback`;
    
    const statePayload = {
      nonce,
      tenantId: session.tenantId,
      identityId: identityId,
      userType: session.userType,
      returnTo: req.query.returnTo || '/settings',
      timestamp: Date.now()
    };

    const signedState = signState(statePayload);

    const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    authUrl.searchParams.set('client_id', MICROSOFT_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', MICROSOFT_SCOPES);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('state', signedState);
    authUrl.searchParams.set('prompt', 'consent');

    console.log('[Outlook OAuth] Initiating auth for identity:', identityId);
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error('[Outlook OAuth] Error initiating auth:', error);
    res.status(500).json({ error: 'Failed to initiate Outlook authentication' });
  }
}
