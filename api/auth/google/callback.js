import crypto from 'crypto';
import { parse, serialize } from 'cookie';
import { createSession } from '../../_lib/session.js';
import { supabase } from '../../_lib/database.js';

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
    console.error('[Google OAuth Callback] OAuth error:', oauthError);
    return res.redirect('/login?error=oauth_denied');
  }

  if (!code || !state) {
    return res.redirect('/login?error=missing_params');
  }

  const stateData = verifyState(state);
  if (!stateData) {
    console.error('[Google OAuth Callback] Invalid or expired state');
    return res.redirect('/login?error=invalid_state');
  }

  const cookies = parse(req.headers.cookie || '');
  const storedNonce = cookies['google_oauth_nonce'];
  
  if (!storedNonce || storedNonce !== stateData.nonce) {
    console.error('[Google OAuth Callback] Nonce mismatch - possible CSRF attack');
    return res.redirect('/login?error=csrf_error');
  }

  const clearNonceCookie = serialize('google_oauth_nonce', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0
  });
  res.setHeader('Set-Cookie', clearNonceCookie);

  try {
    const { tenantId, tenantSlug, returnTo } = stateData;

    const redirectUri = `https://${tenantSlug}.iconn.app/api/auth/google/callback`;

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
      console.error('[Google OAuth Callback] Token exchange failed:', errorData);
      return res.redirect('/login?error=token_exchange_failed');
    }

    const tokens = await tokenResponse.json();
    const { access_token } = tokens;

    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!userInfoResponse.ok) {
      console.error('[Google OAuth Callback] Failed to get user info');
      return res.redirect('/login?error=user_info_failed');
    }

    const googleUser = await userInfoResponse.json();
    const { id: googleId, email, name, picture } = googleUser;

    console.log('[Google OAuth Callback] Google user:', { googleId, email, name });

    let { data: member, error: memberError } = await supabase
      .from('member')
      .select('*')
      .eq('google_id', googleId)
      .eq('tenant_id', tenantId)
      .single();

    if (!member) {
      const { data: memberByEmail } = await supabase
        .from('member')
        .select('*')
        .eq('email', email.toLowerCase())
        .eq('tenant_id', tenantId)
        .single();

      if (memberByEmail) {
        const { data: updatedMember, error: updateError } = await supabase
          .from('member')
          .update({ google_id: googleId })
          .eq('id', memberByEmail.id)
          .select()
          .single();

        if (updateError) {
          console.error('[Google OAuth Callback] Failed to link Google account:', updateError);
          return res.redirect('/login?error=link_failed');
        }

        member = updatedMember;
        console.log('[Google OAuth Callback] Linked Google account to existing member:', member.id);
      }
    }

    if (!member) {
      console.log('[Google OAuth Callback] No member found for Google account, registration required');
      return res.redirect('/login?error=no_account&email=' + encodeURIComponent(email));
    }

    if (member.login_enabled === false) {
      console.log('[Google OAuth Callback] Login disabled for member:', member.id);
      return res.redirect('/login?error=login_disabled');
    }

    let sessionTenantId = member.tenant_id;
    if (!sessionTenantId && member.organization_id) {
      const { data: orgData } = await supabase
        .from('organization')
        .select('tenant_id')
        .eq('id', member.organization_id)
        .single();
      sessionTenantId = orgData?.tenant_id;
    }

    await createSession(res, {
      memberId: member.id,
      memberEmail: member.email,
      tenantId: sessionTenantId || null
    });

    const sessionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    
    let landingPage = '/preferences';
    
    if (member.role_id) {
      const { data: role } = await supabase
        .from('role')
        .select('default_landing_page')
        .eq('id', member.role_id)
        .single();
      
      if (role?.default_landing_page) {
        landingPage = '/' + role.default_landing_page.toLowerCase().replace(/\s+/g, '-');
      }
    }

    const redirectUrl = returnTo || landingPage;
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Signing in...</title></head>
        <body>
          <script>
            localStorage.setItem('agcas_member', JSON.stringify(${JSON.stringify({ ...member, sessionExpiry })}));
            window.location.href = '${redirectUrl}';
          </script>
          <p>Signing in...</p>
        </body>
      </html>
    `;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    console.error('[Google OAuth Callback] Error:', error);
    res.redirect('/login?error=callback_failed');
  }
}
