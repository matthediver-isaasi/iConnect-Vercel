import { supabase } from './database.js';
import { getSessionMember, getSessionTenantUser } from './session.js';
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

const REQUIRE_TENANT_CREDENTIALS = process.env.REQUIRE_TENANT_ZOOM_CREDENTIALS === 'true';

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[ZoomClient] Cannot decrypt - no encryption key configured');
    return null;
  }
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('[ZoomClient] Decryption error:', e.message);
    return null;
  }
}

function decryptCredentials(credentials) {
  if (!credentials) return {};
  const decrypted = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (value && typeof value === 'string' && value.includes(':')) {
      decrypted[key] = decrypt(value);
    } else {
      decrypted[key] = value;
    }
  }
  return decrypted;
}

const tokenCacheByTenant = new Map();

export async function getTenantZoomCredentials(tenantId) {
  if (!supabase || !tenantId) {
    return null;
  }

  try {
    const { data: integration, error } = await supabase
      .from('tenant_integrations')
      .select('credentials, is_enabled')
      .eq('tenant_id', tenantId)
      .eq('integration_type', 'zoom')
      .single();

    if (error || !integration) {
      console.log('[ZoomClient] No Zoom integration found for tenant:', tenantId);
      return null;
    }

    if (!integration.is_enabled) {
      console.log('[ZoomClient] Zoom integration disabled for tenant:', tenantId);
      return null;
    }

    const credentials = decryptCredentials(integration.credentials);
    
    if (!credentials.account_id || !credentials.client_id || !credentials.client_secret) {
      console.log('[ZoomClient] Incomplete Zoom credentials for tenant:', tenantId);
      return null;
    }

    return credentials;
  } catch (error) {
    console.error('[ZoomClient] Error fetching credentials:', error);
    return null;
  }
}

export async function getZoomAccessTokenForTenant(tenantId) {
  const cached = tokenCacheByTenant.get(tenantId);
  if (cached && Date.now() < cached.expiresAt - 60000) {
    return cached.token;
  }

  const credentials = await getTenantZoomCredentials(tenantId);
  
  if (!credentials) {
    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;
    
    if (!accountId || !clientId || !clientSecret) {
      throw new Error('Zoom credentials not configured');
    }
    
    return getZoomTokenWithCredentials('__global__', accountId, clientId, clientSecret);
  }

  return getZoomTokenWithCredentials(
    tenantId, 
    credentials.account_id, 
    credentials.client_id, 
    credentials.client_secret
  );
}

async function getZoomTokenWithCredentials(cacheKey, accountId, clientId, clientSecret) {
  const cached = tokenCacheByTenant.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60000) {
    return cached.token;
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `grant_type=account_credentials&account_id=${accountId}`
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ZoomClient] Token error:', errorText);
    throw new Error(`Failed to get Zoom access token: ${response.status}`);
  }

  const data = await response.json();

  tokenCacheByTenant.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000)
  });

  return data.access_token;
}

export async function getTenantIdFromSession(req) {
  if (!req) return null;
  
  const tenantUser = await getSessionTenantUser(req);
  if (tenantUser?.tenant_id) {
    return tenantUser.tenant_id;
  }
  
  const member = await getSessionMember(req);
  if (member?.tenant_id) {
    return member.tenant_id;
  }
  
  return null;
}

export async function getZoomAccessToken(req, options = {}) {
  const { allowGlobalFallback = true } = options;
  let tenantId = null;
  
  if (req && typeof req === 'object' && (req.headers || req.method)) {
    tenantId = await getTenantIdFromSession(req);
  }
  
  if (tenantId) {
    try {
      const token = await getZoomAccessTokenForTenant(tenantId);
      if (token) return token;
    } catch (e) {
      console.log('[ZoomClient] Tenant credentials failed:', e.message);
      if (!allowGlobalFallback) {
        throw new Error('Zoom credentials not configured for this tenant');
      }
    }
  }

  if (!allowGlobalFallback && REQUIRE_TENANT_CREDENTIALS) {
    throw new Error('Zoom credentials not configured - tenant-specific credentials required');
  }

  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom credentials not configured');
  }

  return getZoomTokenWithCredentials('__global__', accountId, clientId, clientSecret);
}

export function clearTenantZoomTokenCache(tenantId) {
  tokenCacheByTenant.delete(tenantId);
}
