import crypto from 'crypto';
import { parse, serialize } from 'cookie';
import { supabase } from '../../_lib/database.js';
import { evaluateMicrosoftScopes } from '../../_lib/microsoftGraph.js';
import {
  appendInternalQuery,
  normalizeInternalReturnTo,
} from '../../../shared/safeReturnTo.js';
import { isValidOutlookOAuthRedirectUri } from '../../_lib/outlookOAuthRedirect.js';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'iconnect-session-secret-change-in-production';
const DEFAULT_RETURN_TO = '/admin/settings';
const SAFE_ERROR_CODES = new Set([
  'callback_failed',
  'configuration_failed',
  'csrf_error',
  'invalid_state',
  'missing_params',
  'no_refresh_token',
  'oauth_denied',
  'save_failed',
  'token_exchange_failed',
  'user_info_failed',
]);

function diagnostic(operation, code) {
  console.error('[Outlook OAuth Callback]', { operation, code });
}

function safePersistenceCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(code)
    ? code
    : 'unknown';
}

export function isSafeOutlookHost(value) {
  return typeof value === 'string'
    && (value === 'iconn.app' || /^(?:[a-zA-Z0-9-]+\.)+iconn\.app$/.test(value));
}

export function verifyOutlookState(signedState, secret = SESSION_SECRET, now = Date.now()) {
  try {
    if (typeof signedState !== 'string' || !signedState) return null;
    const decoded = JSON.parse(Buffer.from(signedState, 'base64url').toString());
    if (typeof decoded?.data !== 'string' || typeof decoded?.signature !== 'string') return null;
    const expected = crypto.createHmac('sha256', secret).update(decoded.data).digest('hex');
    const actualBuffer = Buffer.from(decoded.signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return null;
    }
    const payload = JSON.parse(decoded.data);
    if (
      !Number.isFinite(payload?.timestamp)
      || now < payload.timestamp
      || now - payload.timestamp > 10 * 60 * 1000
      || typeof payload.nonce !== 'string'
      || !payload.nonce
      || typeof payload.tenantId !== 'string'
      || !payload.tenantId
      || typeof payload.identityId !== 'string'
      || !payload.identityId
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function buildRedirect(path, isProduction, originHost = null) {
  const safePath = normalizeInternalReturnTo(path, DEFAULT_RETURN_TO);
  if (!isProduction) return safePath;
  const safeHost = isSafeOutlookHost(originHost) ? originHost : 'iconn.app';
  return `https://${safeHost}${safePath}`;
}

export function buildOutlookSuccessRedirect({ returnTo, isProduction, originHost }) {
  const finalPath = normalizeInternalReturnTo(returnTo, DEFAULT_RETURN_TO);
  return buildRedirect(
    appendInternalQuery(finalPath, 'outlook_connected', 'true'),
    isProduction,
    originHost
  );
}

export function buildOutlookErrorRedirect({
  returnTo,
  errorCode,
  isProduction,
  originHost,
}) {
  const finalPath = normalizeInternalReturnTo(returnTo, DEFAULT_RETURN_TO);
  const safeCode = SAFE_ERROR_CODES.has(errorCode) ? errorCode : 'callback_failed';
  return buildRedirect(
    appendInternalQuery(finalPath, 'outlook_error', safeCode),
    isProduction,
    originHost
  );
}

function clearNonceCookie(isProduction) {
  return serialize('outlook_oauth_nonce', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    domain: isProduction ? '.iconn.app' : undefined,
    maxAge: 0,
  });
}

function noncesMatch(storedNonce, stateNonce) {
  if (typeof storedNonce !== 'string' || typeof stateNonce !== 'string') return false;
  const stored = Buffer.from(storedNonce);
  const expected = Buffer.from(stateNonce);
  return stored.length === expected.length && crypto.timingSafeEqual(stored, expected);
}

export function createOutlookCallbackHandler({
  database = supabase,
  fetchImpl = globalThis.fetch,
  scopeEvaluator = evaluateMicrosoftScopes,
  clientId = MICROSOFT_CLIENT_ID,
  clientSecret = MICROSOFT_CLIENT_SECRET,
  sessionSecret = SESSION_SECRET,
  now = () => Date.now(),
} = {}) {
  return async function outlookCallbackHandler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const redirectError = (errorCode, stateData = null) => {
      diagnostic('redirect', errorCode);
      res.setHeader('Set-Cookie', clearNonceCookie(isProduction));
      return res.redirect(buildOutlookErrorRedirect({
        returnTo: stateData?.returnTo,
        errorCode,
        isProduction,
        originHost: stateData?.originHost,
      }));
    };

    const { code, state, error: oauthError } = req.query;
    if (!state) return redirectError('missing_params');

    // State and nonce are checked before trusting provider error parameters or
    // any navigation authority carried by the request.
    const stateData = verifyOutlookState(state, sessionSecret, now());
    if (!stateData) return redirectError('invalid_state');
    if (!isValidOutlookOAuthRedirectUri(stateData.oauthRedirectUri, { isProduction })) {
      return redirectError('invalid_state');
    }

    const cookies = parse(req.headers.cookie || '');
    if (!noncesMatch(cookies.outlook_oauth_nonce, stateData.nonce)) {
      return redirectError('csrf_error', stateData);
    }

    if (oauthError) return redirectError('oauth_denied', stateData);
    if (!code) return redirectError('missing_params', stateData);

    if (!clientId || !clientSecret) {
      diagnostic('configuration', 'missing_credentials');
      return redirectError('configuration_failed', stateData);
    }

    const { tenantId, identityId, returnTo, originHost } = stateData;
    const redirectUri = stateData.oauthRedirectUri;

    try {
      const tokenResponse = await fetchImpl('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenResponse.ok) return redirectError('token_exchange_failed', stateData);

      const tokens = await tokenResponse.json();
      const { access_token, refresh_token, expires_in, scope } = tokens;
      if (!refresh_token) return redirectError('no_refresh_token', stateData);

      const userInfoResponse = await fetchImpl('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!userInfoResponse.ok) return redirectError('user_info_failed', stateData);

      const msUser = await userInfoResponse.json();
      const microsoftUserId = msUser.id;
      const microsoftEmail = msUser.mail || msUser.userPrincipalName;
      const tokenExpiresAt = new Date(now() + (expires_in * 1000)).toISOString();
      const scopeHealth = scopeEvaluator(scope);
      const healthFields = {
        health_state: scopeHealth.healthState,
        health_error: scopeHealth.missingScopes.length
          ? `Missing Microsoft permissions: ${scopeHealth.missingScopes.join(', ')}`
          : null,
        health_checked_at: new Date(now()).toISOString(),
      };

      const { data: byIdentity, error: identityLookupError } = await database
        .from('outlook_connection')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('identity_id', identityId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (identityLookupError) {
        diagnostic('identity_lookup', safePersistenceCode(identityLookupError));
        return redirectError('save_failed', stateData);
      }

      let existingConnection = byIdentity;
      if (!existingConnection) {
        const { data: byMsUser, error: msUserLookupError } = await database
          .from('outlook_connection')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('microsoft_user_id', microsoftUserId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (msUserLookupError) {
          diagnostic('microsoft_account_lookup', safePersistenceCode(msUserLookupError));
          return redirectError('save_failed', stateData);
        }
        existingConnection = byMsUser;
      }

      if (existingConnection) {
        const { error: updateError } = await database
          .from('outlook_connection')
          .update({
            identity_id: identityId,
            microsoft_user_id: microsoftUserId,
            microsoft_email: microsoftEmail,
            display_name: msUser.displayName,
            access_token,
            refresh_token,
            token_expires_at: tokenExpiresAt,
            scopes: scope,
            ...healthFields,
            status: 'active',
            sync_error: null,
            updated_at: new Date(now()).toISOString(),
          })
          .eq('tenant_id', tenantId)
          .eq('id', existingConnection.id);
        if (updateError) {
          diagnostic('connection_update', safePersistenceCode(updateError));
          return redirectError('save_failed', stateData);
        }
      } else {
        const { error: insertError } = await database
          .from('outlook_connection')
          .insert({
            tenant_id: tenantId,
            identity_id: identityId,
            microsoft_user_id: microsoftUserId,
            microsoft_email: microsoftEmail,
            display_name: msUser.displayName,
            access_token,
            refresh_token,
            token_expires_at: tokenExpiresAt,
            scopes: scope,
            ...healthFields,
            status: 'active',
          })
          .select()
          .single();
        if (insertError) {
          diagnostic('connection_insert', safePersistenceCode(insertError));
          return redirectError('save_failed', stateData);
        }
      }

      res.setHeader('Set-Cookie', clearNonceCookie(isProduction));
      return res.redirect(buildOutlookSuccessRedirect({
        returnTo,
        isProduction,
        originHost,
      }));
    } catch {
      return redirectError('callback_failed', stateData);
    }
  };
}

export default createOutlookCallbackHandler();