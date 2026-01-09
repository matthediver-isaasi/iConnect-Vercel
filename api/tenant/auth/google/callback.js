import crypto from 'crypto';
import { parse, serialize } from 'cookie';
import { createSession } from '../../../_lib/session.js';
import { supabase } from '../../../_lib/database.js';

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
    
    if (Date.now() - payload.timestamp > 5 * 60 * 1000) {
      return null;
    }
    
    return payload;
  } catch (err) {
    return null;
  }
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
    console.error('[Tenant Google OAuth Callback] OAuth error:', oauthError);
    return res.redirect('/admin/login?error=oauth_denied');
  }

  if (!code || !state) {
    return res.redirect('/admin/login?error=missing_params');
  }

  const stateData = verifyState(state);
  if (!stateData) {
    console.error('[Tenant Google OAuth Callback] Invalid or expired state');
    return res.redirect('/admin/login?error=invalid_state');
  }

  const cookies = parse(req.headers.cookie || '');
  const storedNonce = cookies['tenant_google_oauth_nonce'];
  
  if (!storedNonce || storedNonce !== stateData.nonce) {
    console.error('[Tenant Google OAuth Callback] Nonce mismatch - possible CSRF attack');
    return res.redirect('/admin/login?error=csrf_error');
  }

  const clearNonceCookie = serialize('tenant_google_oauth_nonce', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  });
  res.setHeader('Set-Cookie', clearNonceCookie);

  try {
    const { returnTo } = stateData;

    const host = req.headers.host || 'iconn.app';
    const protocol = req.headers['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
    const redirectUri = `${protocol}://${host}/api/tenant/auth/google/callback`;

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
      console.error('[Tenant Google OAuth Callback] Token exchange failed:', errorData);
      return res.redirect('/admin/login?error=token_exchange_failed');
    }

    const tokens = await tokenResponse.json();
    const { access_token } = tokens;

    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!userInfoResponse.ok) {
      console.error('[Tenant Google OAuth Callback] Failed to get user info');
      return res.redirect('/admin/login?error=user_info_failed');
    }

    const googleUser = await userInfoResponse.json();
    const { id: googleId, email, name, picture } = googleUser;

    console.log('[Tenant Google OAuth Callback] Google user:', { googleId, email, name });

    let { data: tenantUser, error: tenantUserError } = await supabase
      .from('tenant_user')
      .select('*, tenant:tenant_id(*)')
      .eq('google_id', googleId)
      .single();

    if (!tenantUser) {
      const { data: tenantUserByEmail } = await supabase
        .from('tenant_user')
        .select('*, tenant:tenant_id(*)')
        .eq('email', email.toLowerCase())
        .single();

      if (tenantUserByEmail) {
        const { data: updatedTenantUser, error: updateError } = await supabase
          .from('tenant_user')
          .update({ google_id: googleId })
          .eq('id', tenantUserByEmail.id)
          .select('*, tenant:tenant_id(*)')
          .single();

        if (updateError) {
          console.error('[Tenant Google OAuth Callback] Failed to link Google account:', updateError);
          return res.redirect('/admin/login?error=link_failed');
        }

        tenantUser = updatedTenantUser;
        console.log('[Tenant Google OAuth Callback] Linked Google account to existing tenant user:', tenantUser.id);
      }
    }

    if (!tenantUser) {
      console.log('[Tenant Google OAuth Callback] No tenant user found for Google account');
      return res.redirect('/admin/login?error=no_account&email=' + encodeURIComponent(email));
    }

    if (tenantUser.status !== 'active') {
      console.log('[Tenant Google OAuth Callback] Tenant user inactive:', tenantUser.id);
      return res.redirect('/admin/login?error=account_inactive');
    }

    await supabase
      .from('tenant_user_credentials')
      .update({ last_login: new Date().toISOString() })
      .eq('tenant_user_id', tenantUser.id);

    await createSession(res, {
      tenantUserId: tenantUser.id,
      tenantUserEmail: tenantUser.email,
      tenantId: tenantUser.tenant_id,
      userType: 'tenant_user'
    });

    const redirectUrl = returnTo || '/admin/dashboard';
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Signing in...</title></head>
        <body>
          <script>
            localStorage.setItem('saas_admin', JSON.stringify({
              tenantUser: {
                id: '${tenantUser.id}',
                email: '${tenantUser.email}',
                first_name: '${tenantUser.first_name || ''}',
                last_name: '${tenantUser.last_name || ''}',
                role: '${tenantUser.role || ''}'
              },
              tenant: ${JSON.stringify(tenantUser.tenant)}
            }));
            window.location.href = '${redirectUrl}';
          </script>
          <p>Signing in...</p>
        </body>
      </html>
    `;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    console.error('[Tenant Google OAuth Callback] Error:', error);
    res.redirect('/admin/login?error=callback_failed');
  }
}
