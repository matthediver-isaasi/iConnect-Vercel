import { supabase } from './database.js';
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

const DEFAULT_ACCOUNTS_DOMAIN = 'https://accounts.zoho.com';
const DEFAULT_CRM_DOMAIN = 'https://www.zohoapis.com';

const crmTokenCacheByTenant = new Map();

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[ZohoCRM] Cannot decrypt - no encryption key configured');
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
    console.error('[ZohoCRM] Decryption error:', e.message);
    return null;
  }
}

function encrypt(text) {
  if (!text) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[ZohoCRM] Cannot encrypt - no encryption key configured');
    return null;
  }
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (e) {
    console.error('[ZohoCRM] Encryption error:', e.message);
    return null;
  }
}

async function getTenantZohoCrmCredentials(tenantId, options = {}) {
  const { bypassEnabledCheck = false } = options;
  
  if (!supabase || !tenantId) {
    return null;
  }

  try {
    // Use the same integration as Zoho Campaigns (shared Zoho connector)
    const { data: integration, error } = await supabase
      .from('tenant_integrations')
      .select('credentials, is_enabled')
      .eq('tenant_id', tenantId)
      .eq('integration_type', 'zoho_campaigns')
      .single();

    if (error || !integration) {
      console.log('[ZohoCRM] No Zoho integration found for tenant:', tenantId);
      return null;
    }

    if (!bypassEnabledCheck && !integration.is_enabled) {
      console.log('[ZohoCRM] Zoho integration disabled for tenant:', tenantId);
      return null;
    }

    const credentials = integration.credentials || {};
    
    if (credentials.refresh_token) {
      credentials.refresh_token = decrypt(credentials.refresh_token) || credentials.refresh_token;
    }
    if (credentials.access_token) {
      credentials.access_token = decrypt(credentials.access_token) || credentials.access_token;
    }

    return credentials;
  } catch (error) {
    console.error('[ZohoCRM] Error fetching credentials:', error);
    return null;
  }
}

async function saveTenantZohoCrmCredentials(tenantId, credentials, mergeWithExisting = true) {
  if (!supabase || !tenantId) return false;

  try {
    let finalCredentials = { ...credentials };

    let existingIsEnabled = null;
    if (mergeWithExisting) {
      // Use the same integration as Zoho Campaigns (shared Zoho connector)
      const { data: existing } = await supabase
        .from('tenant_integrations')
        .select('credentials, is_enabled')
        .eq('tenant_id', tenantId)
        .eq('integration_type', 'zoho_campaigns')
        .single();

      if (existing?.credentials) {
        finalCredentials = { ...existing.credentials, ...credentials };
      }
      if (typeof existing?.is_enabled === 'boolean') {
        existingIsEnabled = existing.is_enabled;
      }
    }

    if (credentials.refresh_token) {
      finalCredentials.refresh_token = encrypt(credentials.refresh_token);
    }
    if (credentials.access_token) {
      finalCredentials.access_token = encrypt(credentials.access_token);
    }

    // Update the shared Zoho integration. Preserve existing is_enabled
    // (e.g. webhook-secret rotations should never silently re-enable a
    // disabled integration). Only default to true when no row exists yet.
    const { error } = await supabase
      .from('tenant_integrations')
      .upsert({
        tenant_id: tenantId,
        integration_type: 'zoho_campaigns',
        credentials: finalCredentials,
        is_enabled: existingIsEnabled === null ? true : existingIsEnabled,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'tenant_id,integration_type'
      });

    if (error) {
      console.error('[ZohoCRM] Error saving credentials:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[ZohoCRM] Error saving credentials:', error);
    return false;
  }
}

async function refreshCrmAccessToken(tenantId, refreshToken, credentials = null) {
  if (!credentials) {
    credentials = await getTenantZohoCrmCredentials(tenantId);
  }

  const clientId = credentials?.client_id ? decrypt(credentials.client_id) || credentials.client_id : null;
  const clientSecret = credentials?.client_secret ? decrypt(credentials.client_secret) || credentials.client_secret : null;
  const accountsDomain = credentials?.accounts_domain ? (decrypt(credentials.accounts_domain) || credentials.accounts_domain) : DEFAULT_ACCOUNTS_DOMAIN;

  if (!clientId || !clientSecret) {
    throw new Error('Zoho CRM client credentials not configured - please set up in Integrations');
  }

  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  console.log('[ZohoCRM] Refreshing access token for tenant:', tenantId);

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

  const response = await fetch(`${accountsDomain}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ZohoCRM] Token refresh error:', errorText);
    throw new Error(`Failed to refresh Zoho CRM access token: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    console.error('[ZohoCRM] Token refresh error:', data.error);
    throw new Error(`Zoho CRM token refresh failed: ${data.error}`);
  }

  const expiresAt = Date.now() + (data.expires_in * 1000);

  crmTokenCacheByTenant.set(tenantId, {
    token: data.access_token,
    expiresAt
  });

  await saveTenantZohoCrmCredentials(tenantId, {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: new Date(expiresAt).toISOString()
  });

  return data.access_token;
}

export async function getZohoCrmAccessToken(tenantId) {
  const cached = crmTokenCacheByTenant.get(tenantId);
  if (cached && Date.now() < cached.expiresAt - 60000) {
    return cached.token;
  }

  const credentials = await getTenantZohoCrmCredentials(tenantId);
  
  if (!credentials || !credentials.refresh_token) {
    throw new Error('Zoho CRM not connected - please complete OAuth setup');
  }

  if (credentials.access_token && credentials.expires_at) {
    const expiresAt = new Date(credentials.expires_at).getTime();
    if (Date.now() < expiresAt - 60000) {
      crmTokenCacheByTenant.set(tenantId, {
        token: credentials.access_token,
        expiresAt
      });
      return credentials.access_token;
    }
  }

  return refreshCrmAccessToken(tenantId, credentials.refresh_token, credentials);
}

export async function getTenantZohoCrmDomains(tenantId) {
  const credentials = await getTenantZohoCrmCredentials(tenantId);
  
  // Debug logging to trace domain resolution
  console.log('[ZohoCRM] getTenantZohoCrmDomains - raw credentials:', {
    hasCredentials: !!credentials,
    storedAccountsDomain: credentials?.accounts_domain,
    storedCrmDomain: credentials?.crm_domain,
    storedRegion: credentials?.region
  });
  
  const accountsDomain = credentials?.accounts_domain ? (decrypt(credentials.accounts_domain) || credentials.accounts_domain) : DEFAULT_ACCOUNTS_DOMAIN;
  
  console.log('[ZohoCRM] Resolved accounts_domain:', accountsDomain);
  
  // Get crm_domain from credentials, or derive it from accounts_domain
  // e.g., https://accounts.zoho.eu -> https://www.zohoapis.eu
  let crmDomain = credentials?.crm_domain ? (decrypt(credentials.crm_domain) || credentials.crm_domain) : null;
  
  if (!crmDomain) {
    // Derive from accounts domain based on region
    if (accountsDomain.includes('.eu')) {
      crmDomain = 'https://www.zohoapis.eu';
    } else if (accountsDomain.includes('.in')) {
      crmDomain = 'https://www.zohoapis.in';
    } else if (accountsDomain.includes('.com.au')) {
      crmDomain = 'https://www.zohoapis.com.au';
    } else if (accountsDomain.includes('.jp')) {
      crmDomain = 'https://www.zohoapis.jp';
    } else if (accountsDomain.includes('.com.cn')) {
      crmDomain = 'https://www.zohoapis.com.cn';
    } else {
      crmDomain = DEFAULT_CRM_DOMAIN; // US default
    }
    console.log('[ZohoCRM] Derived CRM domain from accounts domain:', accountsDomain, '->', crmDomain);
  } else {
    console.log('[ZohoCRM] Using stored crm_domain:', crmDomain);
  }
  
  console.log('[ZohoCRM] Final domains - accounts:', accountsDomain, 'crm:', crmDomain);
  return { accountsDomain, crmDomain };
}

export async function zohoCrmApiCall(tenantId, endpoint, options = {}, retryCount = 0) {
  const token = await getZohoCrmAccessToken(tenantId);
  const { crmDomain } = await getTenantZohoCrmDomains(tenantId);
  
  const url = `${crmDomain}/crm/v3${endpoint}`;
  
  console.log('[ZohoCRM] API call:', options.method || 'GET', url);
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const responseText = await response.text();
  
  if (!response.ok) {
    console.error('[ZohoCRM] API error:', response.status, responseText);
    
    // Check for INVALID_TOKEN and retry once after clearing cache and forcing refresh
    if (response.status === 401 && responseText.includes('INVALID_TOKEN') && retryCount === 0) {
      console.log('[ZohoCRM] INVALID_TOKEN received, clearing cache and retrying...');
      crmTokenCacheByTenant.delete(tenantId);
      
      // Force a token refresh by getting credentials and refreshing
      const credentials = await getTenantZohoCrmCredentials(tenantId);
      if (credentials?.refresh_token) {
        try {
          await refreshCrmAccessToken(tenantId, credentials.refresh_token, credentials);
          console.log('[ZohoCRM] Token refreshed, retrying API call...');
          return zohoCrmApiCall(tenantId, endpoint, options, retryCount + 1);
        } catch (refreshError) {
          console.error('[ZohoCRM] Token refresh failed:', refreshError);
          throw new Error(`Zoho CRM token refresh failed - please reconnect Zoho in Integrations`);
        }
      }
    }
    
    throw new Error(`Zoho CRM API error: ${response.status} - ${responseText}`);
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return { raw: responseText };
  }
}

export async function searchZohoCrmRecords(tenantId, module, criteria, fields = []) {
  const params = new URLSearchParams();
  params.append('criteria', criteria);
  if (fields.length > 0) {
    params.append('fields', fields.join(','));
  }
  
  try {
    const data = await zohoCrmApiCall(tenantId, `/${module}/search?${params.toString()}`);
    return data.data || [];
  } catch (error) {
    if (error.message.includes('204')) {
      return [];
    }
    throw error;
  }
}

export async function lookupCountryInZoho(tenantId, countryName) {
  if (!countryName) return null;
  
  try {
    const criteria = `(Name:equals:${countryName})`;
    const records = await searchZohoCrmRecords(tenantId, 'Country', criteria, [
      'id', 'Name', 'GSF_Region_Classification', 'Income_Group', 'Flag'
    ]);
    
    if (records.length > 0) {
      return records[0];
    }
    
    const partialCriteria = `(Name:starts_with:${countryName})`;
    const partialRecords = await searchZohoCrmRecords(tenantId, 'Country', partialCriteria, [
      'id', 'Name', 'GSF_Region_Classification', 'Income_Group', 'Flag'
    ]);
    
    return partialRecords.length > 0 ? partialRecords[0] : null;
  } catch (error) {
    console.error('[ZohoCRM] Error looking up country:', countryName, error);
    return null;
  }
}

export async function createZohoOrganization(tenantId, orgData) {
  const payload = {
    data: [orgData],
    trigger: ['workflow']
  };
  
  console.log('[ZohoCRM] Creating organization:', JSON.stringify(payload, null, 2));
  
  const response = await zohoCrmApiCall(tenantId, '/Accounts', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  
  console.log('[ZohoCRM] Create response:', JSON.stringify(response, null, 2));
  
  if (response.data && response.data[0]) {
    const result = response.data[0];
    if (result.status === 'success') {
      return {
        success: true,
        id: result.details.id,
        details: result.details
      };
    } else {
      return {
        success: false,
        error: result.message || 'Unknown error',
        code: result.code,
        details: result.details
      };
    }
  }
  
  return {
    success: false,
    error: 'Unexpected response format',
    response
  };
}

export async function updateZohoOrganization(tenantId, recordId, orgData) {
  const payload = {
    data: [{ ...orgData, id: recordId }],
    trigger: ['workflow']
  };
  
  console.log('[ZohoCRM] Updating organization:', recordId, JSON.stringify(payload, null, 2));
  
  const response = await zohoCrmApiCall(tenantId, '/Accounts', {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  
  console.log('[ZohoCRM] Update response:', JSON.stringify(response, null, 2));
  
  if (response.data && response.data[0]) {
    const result = response.data[0];
    if (result.status === 'success') {
      return {
        success: true,
        id: result.details.id,
        details: result.details
      };
    } else {
      return {
        success: false,
        error: result.message || 'Unknown error',
        code: result.code,
        details: result.details
      };
    }
  }
  
  return {
    success: false,
    error: 'Unexpected response format',
    response
  };
}

export async function getZohoCrmOAuthUrl(tenantId, redirectUri, signedState) {
  const credentials = await getTenantZohoCrmCredentials(tenantId, { bypassEnabledCheck: true });
  const clientId = credentials?.client_id ? decrypt(credentials.client_id) || credentials.client_id : null;
  const accountsDomain = credentials?.accounts_domain ? (decrypt(credentials.accounts_domain) || credentials.accounts_domain) : DEFAULT_ACCOUNTS_DOMAIN;

  if (!clientId) {
    throw new Error('Zoho CRM client ID not configured - please set up in Integrations');
  }

  const scope = 'ZohoCRM.modules.ALL,ZohoCRM.settings.ALL,ZohoCRM.coql.READ';
  
  const params = new URLSearchParams({
    scope,
    client_id: clientId,
    response_type: 'code',
    access_type: 'offline',
    redirect_uri: redirectUri,
    state: signedState || tenantId
  });

  return `${accountsDomain}/oauth/v2/auth?${params.toString()}`;
}

export async function exchangeCrmCodeForTokens(tenantId, code, redirectUri) {
  const credentials = await getTenantZohoCrmCredentials(tenantId, { bypassEnabledCheck: true });
  const clientId = credentials?.client_id ? decrypt(credentials.client_id) || credentials.client_id : null;
  const clientSecret = credentials?.client_secret ? decrypt(credentials.client_secret) || credentials.client_secret : null;
  const accountsDomain = credentials?.accounts_domain ? (decrypt(credentials.accounts_domain) || credentials.accounts_domain) : DEFAULT_ACCOUNTS_DOMAIN;

  if (!clientId || !clientSecret) {
    throw new Error('Zoho CRM client credentials not configured - please set up in Integrations');
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code
  });

  const response = await fetch(`${accountsDomain}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ZohoCRM] Token exchange error:', errorText);
    throw new Error(`Failed to exchange code for tokens: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Zoho OAuth error: ${data.error}`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: new Date(Date.now() + (data.expires_in * 1000)).toISOString()
  };
}

export async function connectZohoCrm(tenantId, code, redirectUri) {
  const tokens = await exchangeCrmCodeForTokens(tenantId, code, redirectUri);
  await saveTenantZohoCrmCredentials(tenantId, tokens);
  return { success: true };
}

export async function isZohoCrmConnected(tenantId) {
  const credentials = await getTenantZohoCrmCredentials(tenantId);
  return !!(credentials && credentials.refresh_token);
}

export async function hasZohoCrmCredentialsConfigured(tenantId) {
  const credentials = await getTenantZohoCrmCredentials(tenantId, { bypassEnabledCheck: true });
  const clientId = credentials?.client_id ? decrypt(credentials.client_id) || credentials.client_id : null;
  return !!clientId;
}

export function clearTenantZohoCrmTokenCache(tenantId) {
  crmTokenCacheByTenant.delete(tenantId);
}

export { getTenantZohoCrmCredentials, saveTenantZohoCrmCredentials, encrypt, decrypt };

// ---------------------------------------------------------------------------
// Per-tenant shared secret used to authenticate inbound Zoho CRM webhooks.
// Stored alongside the existing Zoho integration credentials (encrypted at rest).
// ---------------------------------------------------------------------------

export async function getOrCreateCrmWebhookSecret(tenantId) {
  const credentials = await getTenantZohoCrmCredentials(tenantId, { bypassEnabledCheck: true });
  if (credentials?.crm_webhook_secret) {
    return decrypt(credentials.crm_webhook_secret) || credentials.crm_webhook_secret;
  }
  const newSecret = crypto.randomBytes(32).toString('hex');
  await saveTenantZohoCrmCredentials(tenantId, { crm_webhook_secret: encrypt(newSecret) });
  return newSecret;
}

export async function regenerateCrmWebhookSecret(tenantId) {
  const newSecret = crypto.randomBytes(32).toString('hex');
  await saveTenantZohoCrmCredentials(tenantId, { crm_webhook_secret: encrypt(newSecret) });
  return newSecret;
}

export async function validateCrmWebhookSecret(tenantId, providedSecret) {
  if (!providedSecret) return false;
  const credentials = await getTenantZohoCrmCredentials(tenantId, { bypassEnabledCheck: true });
  if (!credentials?.crm_webhook_secret) return false;
  const stored = decrypt(credentials.crm_webhook_secret) || credentials.crm_webhook_secret;
  // Constant-time compare to avoid timing attacks.
  try {
    const a = Buffer.from(stored, 'utf8');
    const b = Buffer.from(providedSecret, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Metadata + generic upsert helpers used by the Zoho CRM Sync pipeline
// ---------------------------------------------------------------------------

const SYNC_MODULES = ['Contacts', 'Leads', 'Accounts'];

export async function listZohoCrmSyncModules(tenantId) {
  try {
    const data = await zohoCrmApiCall(tenantId, '/settings/modules');
    const modules = (data?.modules || [])
      .filter(m => SYNC_MODULES.includes(m.api_name))
      .map(m => ({
        api_name: m.api_name,
        plural_label: m.plural_label || m.api_name,
        singular_label: m.singular_label || m.api_name
      }));
    if (modules.length === 0) {
      return SYNC_MODULES.map(api_name => ({ api_name, plural_label: api_name, singular_label: api_name }));
    }
    return modules;
  } catch (err) {
    console.error('[ZohoCRM] listZohoCrmSyncModules failed:', err.message);
    return SYNC_MODULES.map(api_name => ({ api_name, plural_label: api_name, singular_label: api_name }));
  }
}

export async function getZohoCrmModuleFields(tenantId, module) {
  if (!module) throw new Error('Module is required');
  const data = await zohoCrmApiCall(tenantId, `/settings/fields?module=${encodeURIComponent(module)}`);
  const fields = (data?.fields || []).map(f => ({
    api_name: f.api_name,
    field_label: f.field_label,
    data_type: f.data_type,
    required: !!(f.system_mandatory || f.required),
    read_only: !!f.read_only,
    custom_field: !!f.custom_field,
    length: f.length || null,
    pick_list_values: (f.pick_list_values || []).map(p => ({ display_value: p.display_value, actual_value: p.actual_value }))
  }));
  return fields;
}

export async function upsertZohoCrmRecord(tenantId, module, recordData, uniqueKeyField) {
  const payload = {
    data: [recordData],
    trigger: ['workflow']
  };
  if (uniqueKeyField) {
    payload.duplicate_check_fields = [uniqueKeyField];
  }
  const response = await zohoCrmApiCall(tenantId, `/${module}/upsert`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (response?.data?.[0]) {
    const result = response.data[0];
    if (result.status === 'success') {
      const action = result.action || (result.details?.Created_Time === result.details?.Modified_Time ? 'insert' : 'update');
      return {
        success: true,
        id: result.details?.id,
        action,
        details: result.details,
        raw: response
      };
    }
    return {
      success: false,
      error: result.message || 'Unknown error from Zoho CRM',
      code: result.code,
      details: result.details,
      raw: response
    };
  }
  return { success: false, error: 'No data in Zoho CRM response', raw: response };
}

export async function updateZohoCrmRecordById(tenantId, module, recordId, recordData) {
  const payload = {
    data: [{ id: recordId, ...recordData }],
    trigger: ['workflow']
  };
  const response = await zohoCrmApiCall(tenantId, `/${module}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  if (response?.data?.[0]) {
    const result = response.data[0];
    if (result.status === 'success') {
      return { success: true, id: result.details?.id || recordId, action: 'update', details: result.details, raw: response };
    }
    return { success: false, error: result.message || 'Unknown error', code: result.code, raw: response };
  }
  return { success: false, error: 'No data in Zoho CRM response', raw: response };
}

