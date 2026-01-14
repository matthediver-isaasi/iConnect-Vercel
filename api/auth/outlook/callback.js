import crypto from 'crypto';
import { parse, serialize } from 'cookie';
import { supabase } from '../../_lib/database.js';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
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
    console.error('[Outlook OAuth Callback] State verification error:', err);
    return null;
  }
}

function buildRedirect(path, isProduction) {
  if (isProduction) {
    return `https://iconn.app${path}`;
  }
  return path;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
    console.error('[Outlook OAuth Callback] Missing credentials');
    return res.status(500).json({ error: 'Microsoft OAuth not configured' });
  }

  const { code, state, error: oauthError, error_description } = req.query;
  const isProduction = process.env.NODE_ENV === 'production';

  if (oauthError) {
    console.error('[Outlook OAuth Callback] OAuth error:', oauthError, error_description);
    return res.redirect(buildRedirect(`/settings?outlook_error=${encodeURIComponent(oauthError)}`, isProduction));
  }

  if (!code || !state) {
    console.error('[Outlook OAuth Callback] Missing code or state');
    return res.redirect(buildRedirect('/settings?outlook_error=missing_params', isProduction));
  }

  const stateData = verifyState(state);
  if (!stateData) {
    console.error('[Outlook OAuth Callback] Invalid or expired state');
    return res.redirect(buildRedirect('/settings?outlook_error=invalid_state', isProduction));
  }

  const cookies = parse(req.headers.cookie || '');
  const storedNonce = cookies['outlook_oauth_nonce'];
  
  if (!storedNonce || storedNonce !== stateData.nonce) {
    console.error('[Outlook OAuth Callback] Nonce mismatch');
    return res.redirect(buildRedirect('/settings?outlook_error=csrf_error', isProduction));
  }

  const clearNonceCookie = serialize('outlook_oauth_nonce', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    domain: isProduction ? '.iconn.app' : undefined,
    maxAge: 0
  });

  try {
    const { tenantId, identityId, returnTo } = stateData;

    const redirectUri = isProduction 
      ? 'https://iconn.app/api/auth/outlook/callback'
      : `http://${req.headers.host}/api/auth/outlook/callback`;

    const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error('[Outlook OAuth Callback] Token exchange failed:', errorData);
      return res.redirect(buildRedirect('/settings?outlook_error=token_exchange_failed', isProduction));
    }

    const tokens = await tokenResponse.json();
    const { access_token, refresh_token, expires_in, scope } = tokens;

    if (!refresh_token) {
      console.error('[Outlook OAuth Callback] No refresh token received - user may need to re-consent');
      return res.redirect(buildRedirect('/settings?outlook_error=no_refresh_token', isProduction));
    }

    const userInfoResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!userInfoResponse.ok) {
      console.error('[Outlook OAuth Callback] Failed to get user info');
      return res.redirect(buildRedirect('/settings?outlook_error=user_info_failed', isProduction));
    }

    const msUser = await userInfoResponse.json();
    const { id: microsoftUserId, mail, userPrincipalName, displayName } = msUser;
    const microsoftEmail = mail || userPrincipalName;

    console.log('[Outlook OAuth Callback] Microsoft user:', { microsoftUserId, microsoftEmail, displayName });

    const tokenExpiresAt = new Date(Date.now() + (expires_in * 1000)).toISOString();

    const { data: existingConnection, error: checkError } = await supabase
      .from('outlook_connection')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('identity_id', identityId)
      .single();

    if (existingConnection) {
      const { error: updateError } = await supabase
        .from('outlook_connection')
        .update({
          microsoft_user_id: microsoftUserId,
          microsoft_email: microsoftEmail,
          display_name: displayName,
          access_token: access_token,
          refresh_token: refresh_token,
          token_expires_at: tokenExpiresAt,
          scopes: scope,
          status: 'active',
          sync_error: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingConnection.id);

      if (updateError) {
        console.error('[Outlook OAuth Callback] Failed to update connection:', updateError);
        return res.redirect(buildRedirect('/settings?outlook_error=save_failed', isProduction));
      }

      console.log('[Outlook OAuth Callback] Updated existing Outlook connection:', existingConnection.id);
    } else {
      const { data: newConnection, error: insertError } = await supabase
        .from('outlook_connection')
        .insert({
          tenant_id: tenantId,
          identity_id: identityId,
          microsoft_user_id: microsoftUserId,
          microsoft_email: microsoftEmail,
          display_name: displayName,
          access_token: access_token,
          refresh_token: refresh_token,
          token_expires_at: tokenExpiresAt,
          scopes: scope,
          status: 'active'
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Outlook OAuth Callback] Failed to save connection:', insertError);
        return res.redirect(buildRedirect('/settings?outlook_error=save_failed', isProduction));
      }

      console.log('[Outlook OAuth Callback] Created new Outlook connection:', newConnection.id);
    }

    res.setHeader('Set-Cookie', clearNonceCookie);

    const finalPath = returnTo || '/settings';
    const successRedirect = buildRedirect(`${finalPath}?outlook_connected=true`, isProduction);
    
    res.redirect(successRedirect);

  } catch (error) {
    console.error('[Outlook OAuth Callback] Error:', error);
    res.setHeader('Set-Cookie', clearNonceCookie);
    res.redirect(buildRedirect('/settings?outlook_error=callback_failed', isProduction));
  }
}
