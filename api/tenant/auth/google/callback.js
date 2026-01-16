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

  // Use host-based detection for cookie domain
  // Only use .iconn.app domain when actually on iconn.app (not Vercel preview URLs)
  const host = req.headers.host || '';
  const isOnIconnDomain = host.endsWith('.iconn.app') || host === 'iconn.app';
  const clearNonceCookie = serialize('tenant_google_oauth_nonce', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    domain: isOnIconnDomain ? '.iconn.app' : undefined,
    maxAge: 0
  });
  // Don't set cookie here - combine with session cookie later

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

    // First, look up or create tenant_identity for unified identity system
    let identity = null;
    
    // Look up by google_id first (most reliable)
    const { data: identityByGoogle } = await supabase
      .from('tenant_identity')
      .select('*')
      .eq('google_id', googleId)
      .single();

    if (identityByGoogle) {
      identity = identityByGoogle;
    } else {
      // Look up by email if no google_id match
      const { data: identityByEmail } = await supabase
        .from('tenant_identity')
        .select('*')
        .eq('email', email.toLowerCase())
        .single();

      if (identityByEmail) {
        identity = identityByEmail;
        // Link google_id to this identity
        await supabase
          .from('tenant_identity')
          .update({ google_id: googleId })
          .eq('id', identityByEmail.id);
        console.log('[Tenant Google OAuth Callback] Linked Google ID to existing identity:', identityByEmail.id);
      }
    }

    // If no identity exists, create one for the unified system
    if (!identity) {
      const nameParts = (name || '').split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      
      const { data: newIdentity, error: createError } = await supabase
        .from('tenant_identity')
        .insert({
          email: email.toLowerCase(),
          first_name: firstName,
          last_name: lastName,
          google_id: googleId
        })
        .select()
        .single();

      if (!createError && newIdentity) {
        identity = newIdentity;
        console.log('[Tenant Google OAuth Callback] Created new identity:', newIdentity.id);
      } else {
        console.error('[Tenant Google OAuth Callback] Failed to create identity:', createError);
      }
    }

    console.log('[Tenant Google OAuth Callback] Identity:', { identityId: identity?.id, email });

    // Update ALL tenant_user records with this email to link identity_id and google_id
    // This ensures tenant switching works across all tenants the user owns
    if (identity) {
      const { data: allTenantUsers, error: updateAllError } = await supabase
        .from('tenant_user')
        .update({ 
          identity_id: identity.id,
          google_id: googleId 
        })
        .eq('email', email.toLowerCase())
        .select('id');
      
      if (updateAllError) {
        console.error('[Tenant Google OAuth Callback] Failed to update all tenant_users:', updateAllError);
      } else {
        console.log('[Tenant Google OAuth Callback] Updated identity_id and google_id for', allTenantUsers?.length || 0, 'tenant_user records');
      }
    }

    // Find ALL tenant_users for this identity to check if user has multiple tenants
    let allTenantUsersForIdentity = [];
    
    // Query by google_id first
    const { data: tenantUsersByGoogle } = await supabase
      .from('tenant_user')
      .select('*, tenant:tenant_id(*)')
      .eq('google_id', googleId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    
    if (tenantUsersByGoogle?.length > 0) {
      allTenantUsersForIdentity = tenantUsersByGoogle;
    }
    
    // If no results by google_id, try by identity_id
    if (allTenantUsersForIdentity.length === 0 && identity) {
      const { data: tenantUsersByIdentity } = await supabase
        .from('tenant_user')
        .select('*, tenant:tenant_id(*)')
        .eq('identity_id', identity.id)
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      
      if (tenantUsersByIdentity?.length > 0) {
        allTenantUsersForIdentity = tenantUsersByIdentity;
      }
    }
    
    // Final fallback - by email
    if (allTenantUsersForIdentity.length === 0) {
      const { data: tenantUsersByEmail } = await supabase
        .from('tenant_user')
        .select('*, tenant:tenant_id(*)')
        .eq('email', email.toLowerCase())
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      
      if (tenantUsersByEmail?.length > 0) {
        allTenantUsersForIdentity = tenantUsersByEmail;
      }
    }

    if (allTenantUsersForIdentity.length === 0) {
      console.log('[Tenant Google OAuth Callback] No tenant user found for Google account');
      return res.redirect('/admin/login?error=no_account&email=' + encodeURIComponent(email));
    }

    // Check if user has multiple tenants - redirect to selection WITHOUT creating session
    // Session will be created after user picks a tenant to prevent auto-redirect to dashboard
    if (allTenantUsersForIdentity.length > 1) {
      console.log('[Tenant Google OAuth Callback] User has', allTenantUsersForIdentity.length, 'tenants, redirecting to selection (no session created)');
      
      // Build tenant list with tenant_user IDs for the selection page
      const tenantList = allTenantUsersForIdentity.map(tu => ({
        id: tu.tenant_id,
        tenantUserId: tu.id, // Include tenant_user.id for session creation
        name: tu.tenant?.name,
        slug: tu.tenant?.slug,
        logo_url: tu.tenant?.logo_url
      }));
      
      const identityIdForStorage = identity?.id || allTenantUsersForIdentity[0].identity_id || '';
      
      // Clear the nonce cookie
      res.setHeader('Set-Cookie', clearNonceCookie);
      
      // Redirect to login page with tenant selection data in localStorage
      // NO SESSION IS CREATED - this prevents auto-redirect to dashboard
      const html = `
        <!DOCTYPE html>
        <html>
          <head><title>Select Workspace...</title></head>
          <body>
            <script>
              localStorage.setItem('sso_tenant_selection', JSON.stringify({
                identity: {
                  id: '${identityIdForStorage}',
                  email: '${email}',
                  first_name: '${firstName || ''}',
                  last_name: '${lastName || ''}'
                },
                tenants: ${JSON.stringify(tenantList)},
                googleId: '${googleId}'
              }));
              window.location.href = '/admin/login?sso_select_tenant=true';
            </script>
            <p>Loading workspaces...</p>
          </body>
        </html>
      `;
      
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }

    // Single tenant - log in directly
    const tenantUser = allTenantUsersForIdentity[0];

    console.log('[Tenant Google OAuth Callback] Logging into tenant:', tenantUser.tenant?.name, 'with identity_id:', identity?.id);

    await supabase
      .from('tenant_user_credentials')
      .update({ last_login: new Date().toISOString() })
      .eq('tenant_user_id', tenantUser.id);

    await createSession(res, {
      tenantUserId: tenantUser.id,
      tenantUserEmail: tenantUser.email,
      tenantId: tenantUser.tenant_id,
      identityId: identity?.id || tenantUser.identity_id,
      userType: 'tenant_user'
    }, { req });

    // Combine session cookie with clearNonceCookie
    const existingCookies = res.getHeader('Set-Cookie');
    const allCookies = Array.isArray(existingCookies) 
      ? [...existingCookies, clearNonceCookie]
      : existingCookies 
        ? [existingCookies, clearNonceCookie]
        : [clearNonceCookie];
    res.setHeader('Set-Cookie', allCookies);

    console.log('[Tenant Google OAuth Callback] Session created with identityId:', identity?.id || tenantUser.identity_id);

    // Always redirect to /admin/dashboard on the current host (iconn.app)
    // Tenant owners stay on iconn.app to manage their tenants
    // They only go to tenant subdomains when clicking "Open Portal"
    const redirectUrl = returnTo || '/admin/dashboard';
    
    const identityIdForStorage = identity?.id || tenantUser.identity_id || '';
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
              tenant: ${JSON.stringify(tenantUser.tenant)},
              identityId: '${identityIdForStorage}',
              hasMultipleTenants: false
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
