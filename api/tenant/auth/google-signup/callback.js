import crypto from 'crypto';
import { parse, serialize } from 'cookie';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'iconnect-session-secret-change-in-production';

function verifyState(signedState) {
  try {
    const decoded = JSON.parse(Buffer.from(signedState, 'base64url').toString());
    const { data, signature } = decoded;
    const expectedSignature = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
    
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null;
    }
    
    const payload = JSON.parse(data);
    
    if (Date.now() - payload.timestamp > 10 * 60 * 1000) {
      return null;
    }
    
    return payload;
  } catch (err) {
    return null;
  }
}

function signData(payload) {
  const data = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, signature })).toString('base64url');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Google OAuth not configured' });
  }

  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    console.error('[Tenant Google Signup Callback] OAuth error:', oauthError);
    return res.redirect('/signup?error=oauth_denied');
  }

  if (!code || !state) {
    return res.redirect('/signup?error=missing_params');
  }

  const stateData = verifyState(state);
  if (!stateData || stateData.flow !== 'signup') {
    console.error('[Tenant Google Signup Callback] Invalid or expired state');
    return res.redirect('/signup?error=invalid_state');
  }

  const cookies = parse(req.headers.cookie || '');
  const storedNonce = cookies['tenant_google_signup_nonce'];
  
  if (!storedNonce || storedNonce !== stateData.nonce) {
    console.error('[Tenant Google Signup Callback] Nonce mismatch - possible CSRF attack');
    return res.redirect('/signup?error=csrf_error');
  }

  const clearNonceCookie = serialize('tenant_google_signup_nonce', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  });

  try {
    const redirectUri = 'https://iconn.app/api/tenant/auth/google-signup/callback';

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('[Tenant Google Signup Callback] Token exchange failed:', errorData);
      return res.redirect('/signup?error=token_exchange_failed');
    }

    const tokens = await tokenResponse.json();
    const { access_token } = tokens;

    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!userInfoResponse.ok) {
      console.error('[Tenant Google Signup Callback] Failed to get user info');
      return res.redirect('/signup?error=user_info_failed');
    }

    const googleUser = await userInfoResponse.json();
    const { id: googleId, email, given_name, family_name } = googleUser;

    console.log('[Tenant Google Signup Callback] Google user:', { googleId, email, given_name, family_name });

    const signedGoogleData = signData({
      googleId,
      email,
      firstName: given_name || '',
      lastName: family_name || '',
      timestamp: Date.now()
    });

    const googleDataCookie = serialize('google_signup_data', signedGoogleData, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600
    });

    res.setHeader('Set-Cookie', [clearNonceCookie, googleDataCookie]);

    res.redirect('/signup?google=true');

  } catch (error) {
    console.error('[Tenant Google Signup Callback] Error:', error);
    res.redirect('/signup?error=callback_failed');
  }
}
