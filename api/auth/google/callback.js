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

function buildErrorRedirect(tenantSlug, error, isProduction, extraParams = '') {
  if (isProduction && tenantSlug) {
    return `https://${tenantSlug}.iconn.app/login?error=${error}${extraParams}`;
  }
  return `/login?error=${error}${extraParams}`;
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
  const isProduction = process.env.NODE_ENV === 'production';

  let tenantSlug = null;
  let stateData = null;

  if (state) {
    stateData = verifyState(state);
    if (stateData) {
      tenantSlug = stateData.tenantSlug;
    }
  }

  if (oauthError) {
    console.error('[Google OAuth Callback] OAuth error:', oauthError);
    return res.redirect(buildErrorRedirect(tenantSlug, 'oauth_denied', isProduction));
  }

  if (!code || !state) {
    return res.redirect(buildErrorRedirect(tenantSlug, 'missing_params', isProduction));
  }

  if (!stateData) {
    console.error('[Google OAuth Callback] Invalid or expired state');
    return res.redirect(buildErrorRedirect(tenantSlug, 'invalid_state', isProduction));
  }

  const cookies = parse(req.headers.cookie || '');
  const storedNonce = cookies['google_oauth_nonce'];
  
  if (!storedNonce || storedNonce !== stateData.nonce) {
    console.error('[Google OAuth Callback] Nonce mismatch - possible CSRF attack');
    return res.redirect(buildErrorRedirect(tenantSlug, 'csrf_error', isProduction));
  }

  const clearNonceCookie = serialize('google_oauth_nonce', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    domain: isProduction ? '.iconn.app' : undefined,
    maxAge: 0
  });

  try {
    const { tenantId, returnTo } = stateData;

    const host = req.headers.host || 'iconn.app';
    const protocol = req.headers['x-forwarded-proto'] || (isProduction ? 'https' : 'http');
    
    const redirectUri = isProduction 
      ? 'https://iconn.app/api/auth/google/callback'
      : `${protocol}://${host}/api/auth/google/callback`;

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
      return res.redirect(buildErrorRedirect(tenantSlug, 'token_exchange_failed', isProduction));
    }

    const tokens = await tokenResponse.json();
    const { access_token } = tokens;

    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!userInfoResponse.ok) {
      console.error('[Google OAuth Callback] Failed to get user info');
      return res.redirect(buildErrorRedirect(tenantSlug, 'user_info_failed', isProduction));
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
        // Try to link google_id, but don't fail if it conflicts (unique constraint)
        // This can happen when the same Google account is used across multiple tenants
        const { data: updatedMember, error: updateError } = await supabase
          .from('member')
          .update({ google_id: googleId })
          .eq('id', memberByEmail.id)
          .select()
          .single();

        if (updateError) {
          // Log but don't fail - the member can still log in
          console.warn('[Google OAuth Callback] Could not link Google ID (may be duplicate):', updateError.message);
          member = memberByEmail;
        } else {
          member = updatedMember;
          console.log('[Google OAuth Callback] Linked Google account to existing member:', member.id);
        }
      }
    }

    if (!member) {
      console.log('[Google OAuth Callback] No member found for Google account, registration required');
      return res.redirect(buildErrorRedirect(tenantSlug, 'no_account', isProduction, `&email=${encodeURIComponent(email)}`));
    }

    if (member.login_enabled === false) {
      console.log('[Google OAuth Callback] Login disabled for member:', member.id);
      return res.redirect(buildErrorRedirect(tenantSlug, 'login_disabled', isProduction));
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

    // Look up or resolve identity for unified authentication
    // Check if member has an identity_id or if there's a tenant_identity with this email
    let identityId = member.identity_id;
    
    if (!identityId) {
      // Try to find existing tenant_identity by email
      const { data: existingIdentity } = await supabase
        .from('tenant_identity')
        .select('id')
        .eq('email', email.toLowerCase())
        .single();
      
      if (existingIdentity) {
        identityId = existingIdentity.id;
        // Link the member to this identity for future lookups
        await supabase
          .from('member')
          .update({ identity_id: identityId })
          .eq('id', member.id);
        console.log('[Google OAuth Callback] Linked member to existing identity:', identityId);
      }
    }

    const cookieDomain = isProduction ? '.iconn.app' : undefined;
    
    await createSession(res, {
      userType: 'member',
      memberId: member.id,
      memberEmail: member.email,
      tenantId: sessionTenantId || null,
      identityId: identityId || null
    }, { cookieDomain });

    const existingCookies = res.getHeader('Set-Cookie');
    const allCookies = Array.isArray(existingCookies) 
      ? [...existingCookies, clearNonceCookie]
      : existingCookies 
        ? [existingCookies, clearNonceCookie]
        : [clearNonceCookie];
    res.setHeader('Set-Cookie', allCookies);

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

    const finalPath = returnTo || landingPage;
    const finalRedirect = isProduction 
      ? `https://${tenantSlug}.iconn.app${finalPath}`
      : finalPath;
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Signing in...</title></head>
        <body>
          <script>
            localStorage.setItem('agcas_member', JSON.stringify(${JSON.stringify({ ...member, sessionExpiry })}));
            window.location.href = '${finalRedirect}';
          </script>
          <p>Signing in...</p>
        </body>
      </html>
    `;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);

  } catch (error) {
    console.error('[Google OAuth Callback] Error:', error);
    res.redirect(buildErrorRedirect(tenantSlug, 'callback_failed', isProduction));
  }
}
