import { supabase } from './database.js';
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

const DEFAULT_ACCOUNTS_DOMAIN = 'https://accounts.zoho.com';
const DEFAULT_CRM_DOMAIN = 'https://www.zohoapis.com';

// Hard cap on every outbound HTTP call to Zoho. Without this, a single slow
// or hung Zoho response will tie up a Vercel function for the full 60s
// runtime limit, which under retry pressure (e.g. Zoho Flow re-firing a
// webhook) saturates concurrency and makes the whole app appear "stuck on
// Loading". Tune via env if needed but keep it well below the 60s cap.
export const ZOHO_HTTP_TIMEOUT_MS = Number(process.env.ZOHO_HTTP_TIMEOUT_MS) || 10000;

export class ZohoTimeoutError extends Error {
  constructor(url, timeoutMs) {
    super(`Zoho HTTP request timed out after ${timeoutMs}ms: ${url}`);
    this.name = 'ZohoTimeoutError';
    this.timeoutMs = timeoutMs;
    this.url = url;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = ZOHO_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ZohoTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const crmTokenCacheByTenant = new Map();

// Matches our encrypted-at-rest shape: `<32-hex-char IV>:<non-empty hex ciphertext>`.
// Anything else is treated as plaintext and returns null silently so callers
// can fall back via `decrypt(x) || x` without polluting logs.
const ENCRYPTED_VALUE_RE = /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/;

function looksEncrypted(value) {
  return typeof value === 'string' && ENCRYPTED_VALUE_RE.test(value);
}

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!looksEncrypted(encryptedText)) {
    // Plaintext value (e.g. `https://www.zohoapis.eu`) — not an error.
    return null;
  }
  if (!ENCRYPTION_KEY) {
    console.error('[ZohoCRM] Cannot decrypt - no encryption key configured');
    return null;
  }
  try {
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
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

  const response = await fetchWithTimeout(`${accountsDomain}/oauth/v2/token`, {
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

  // Most Zoho CRM REST endpoints work identically across v3 and v8 and our
  // historical baseline is v3, so default there to avoid a blanket bump that
  // would surface unrelated regressions. Specific helpers (currently the
  // rich-text fetch) opt into a newer version because Zoho renamed/relocated
  // those endpoints — see fetchZohoCrmRecordRichText for the precedent.
  const apiVersion = options.apiVersion || 'v3';
  const url = `${crmDomain}/crm/${apiVersion}${endpoint}`;

  console.log('[ZohoCRM] API call:', options.method || 'GET', url);

  // Strip apiVersion from the options before forwarding to fetch — it's not a
  // valid RequestInit key and would be ignored, but explicit is safer.
  const { apiVersion: _apiVersion, ...fetchOptions } = options;
  const response = await fetchWithTimeout(url, {
    ...fetchOptions,
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

  const response = await fetchWithTimeout(`${accountsDomain}/oauth/v2/token`, {
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

function mapZohoField(f) {
  if (!f) return null;
  // Layouts sometimes carry the api name under `name` instead of `api_name`,
  // and the human label under `display_label` instead of `field_label`.
  // Accept either so we don't silently drop fields that came in via the
  // layouts merge path.
  const apiName = f.api_name || f.name;
  if (!apiName) return null;
  return {
    api_name: apiName,
    field_label: f.field_label || f.display_label || apiName,
    data_type: f.data_type,
    required: !!(f.system_mandatory || f.required),
    read_only: !!f.read_only,
    custom_field: !!f.custom_field,
    length: f.length || null,
    pick_list_values: (f.pick_list_values || []).map(p => ({ display_value: p.display_value, actual_value: p.actual_value }))
  };
}

// Walk a single layout payload, calling `cb(field, section)` for each
// section-field. Shared by both the cached fields aggregator (which
// ignores `section`) and the diagnostic (which uses it for context).
function walkLayoutSections(layout, cb) {
  for (const section of (layout?.sections || [])) {
    for (const f of (section?.fields || [])) {
      if (f) cb(f, section);
    }
  }
}

function collectRawFieldsFromLayout(layout) {
  const out = [];
  walkLayoutSections(layout, (f) => out.push(f));
  return out;
}

// Short-lived cache so a single page-load that opens many dropdowns doesn't
// hit Zoho twice per render. Layout aggregation costs an extra HTTP call,
// so the cache also matters for tenants with many fields/layouts.
const moduleFieldsCache = new Map();
const MODULE_FIELDS_TTL_MS = 5 * 60 * 1000;

function moduleFieldsCacheKey(tenantId, module) {
  return `${tenantId}:${module}`;
}

export function clearZohoCrmModuleFieldsCache(tenantId, module) {
  if (!tenantId) {
    moduleFieldsCache.clear();
    return;
  }
  if (!module) {
    for (const k of moduleFieldsCache.keys()) {
      if (k.startsWith(`${tenantId}:`)) moduleFieldsCache.delete(k);
    }
    return;
  }
  moduleFieldsCache.delete(moduleFieldsCacheKey(tenantId, module));
}

/**
 * Fetch a single record's rich-text field values via Zoho's documented
 * `GET /{module}/{record_id}/actions/fetch_full_data` endpoint (v8). Zoho
 * excludes rich-text fields from `/settings/fields` (even with `type=all`),
 * `/settings/layouts`, the Search API, AND the regular
 * `GET /{module}/{record_id}` payload — this dedicated endpoint is the
 * only way to read them.
 *
 * The previous `actions/rich_text` path is undocumented in v3 and absent
 * from v8 entirely. Empirically Zoho's gateway accepts the old name and
 * returns an empty `data` array instead of erroring, which made every
 * read look like a "field not present" miss. The v8 doc explicitly
 * specifies `actions/fetch_full_data` — see
 * https://www.zoho.com/crm/developer/docs/api/v8/get-rich-text-fields.html
 * for the canonical reference (also documents the 200-id / 8-field caps
 * for the multi-record variant).
 *
 * Returns a flat `{ api_name: html_value }` map. `id` is stripped. Values
 * that aren't strings or null are dropped (the rich-text endpoint only
 * returns those two shapes). Pass an explicit `fieldApiNames` array to
 * scope the call (becomes a `?fields=` query); pass null/omit to fetch
 * every rich-text field on the record. An empty array short-circuits and
 * skips the HTTP call entirely.
 */
export async function fetchZohoCrmRecordRichText(tenantId, module, recordId, fieldApiNames) {
  if (!module) throw new Error('Module is required');
  if (!recordId) throw new Error('Record id is required');
  if (Array.isArray(fieldApiNames) && fieldApiNames.length === 0) return {};
  const enc = encodeURIComponent(module);
  const encId = encodeURIComponent(recordId);
  let path = `/${enc}/${encId}/actions/fetch_full_data`;
  if (Array.isArray(fieldApiNames) && fieldApiNames.length > 0) {
    path += `?fields=${encodeURIComponent(fieldApiNames.join(','))}`;
  }
  const resp = await zohoCrmApiCall(tenantId, path, { apiVersion: 'v8' });
  const row = Array.isArray(resp?.data) && resp.data.length > 0 ? resp.data[0] : null;
  if (!row || typeof row !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id') continue;
    if (typeof v === 'string') out[k] = v;
    else if (v == null) out[k] = null;
  }
  return out;
}

// Field types we explicitly never want in the mapping dropdown — they
// surface from layouts but aren't writable text-style fields. The
// rich-text type ("textarea" with rich-text view, or `richtextarea`) is
// NOT in this list — that's the whole point of the layouts merge.
const LAYOUT_DATA_TYPE_DENY = new Set([
  'subform',
  'imageupload', 'image_upload',
  'fileupload', 'file_upload',
  'profileimage', 'profile_image'
]);

// Cap the number of per-layout detail calls per request so a tenant with
// many custom layouts can't blow the function timeout budget. Set
// generously — a single module rarely has more than a handful of
// layouts, and Accounts/Contacts/Leads are well under this in practice.
// If we ever hit the cap we warn so it's easy to spot in logs and revisit.
const MAX_LAYOUT_DETAIL_CALLS = 25;

// Try `/settings/fields?module=X&type=all` first — Zoho documents this as
// the qualifier that returns every field type including rich-text. If the
// qualified call fails or returns nothing, fall back to the bare call so
// we never end up with fewer fields than before.
async function fetchPrimaryZohoFields(tenantId, module) {
  const enc = encodeURIComponent(module);
  try {
    const r = await zohoCrmApiCall(tenantId, `/settings/fields?module=${enc}&type=all`);
    if (Array.isArray(r?.fields) && r.fields.length > 0) {
      return { res: r, qualifier: 'type=all' };
    }
  } catch (err) {
    console.warn('[ZohoCRM] /settings/fields?type=all failed for', module, '-', err?.message || err);
  }
  const r = await zohoCrmApiCall(tenantId, `/settings/fields?module=${enc}`);
  return { res: r, qualifier: 'default' };
}

// Walk `/settings/layouts` and, for any layout that came back as a summary
// without embedded section fields, fetch its detail individually. Returns
// the raw fields harvested from layouts plus per-layout debug breadcrumbs.
async function fetchZohoLayoutFields(tenantId, module) {
  const enc = encodeURIComponent(module);
  const layoutsRes = await zohoCrmApiCall(tenantId, `/settings/layouts?module=${enc}`);
  const layouts = Array.isArray(layoutsRes?.layouts) ? layoutsRes.layouts : [];
  // rawFields is an array of `{ field, source }` so the caller can record
  // exact endpoint attribution per field ('layouts_list' vs 'layouts_detail').
  const rawFields = [];
  const layoutsDebug = [];
  let detailCalls = 0;
  let cappedCount = 0;

  for (const layout of layouts) {
    const layoutId = layout?.id;
    const layoutName = layout?.name || null;
    const embedded = collectRawFieldsFromLayout(layout);
    if (embedded.length > 0) {
      layoutsDebug.push({ id: layoutId, name: layoutName, source: 'list_embedded', field_count: embedded.length });
      for (const f of embedded) rawFields.push({ field: f, source: 'layouts_list' });
      continue;
    }
    if (!layoutId) {
      layoutsDebug.push({ id: null, name: layoutName, source: 'list_no_id', field_count: 0 });
      continue;
    }
    if (detailCalls >= MAX_LAYOUT_DETAIL_CALLS) {
      layoutsDebug.push({ id: layoutId, name: layoutName, source: 'detail_skipped_cap', field_count: 0 });
      cappedCount++;
      continue;
    }
    detailCalls++;
    try {
      const detailRes = await zohoCrmApiCall(tenantId, `/settings/layouts/${encodeURIComponent(layoutId)}?module=${enc}`);
      // Detail endpoint can return either `{ layouts: [layout] }` or the
      // bare layout object — accept both shapes.
      const detailLayout = Array.isArray(detailRes?.layouts) ? detailRes.layouts[0] : (detailRes?.layout || detailRes);
      const detailFields = collectRawFieldsFromLayout(detailLayout);
      layoutsDebug.push({ id: layoutId, name: layoutName, source: 'detail_fetch', field_count: detailFields.length });
      for (const f of detailFields) rawFields.push({ field: f, source: 'layouts_detail' });
    } catch (err) {
      layoutsDebug.push({ id: layoutId, name: layoutName, source: 'detail_fetch_error', error: err?.message || String(err), field_count: 0 });
    }
  }

  if (cappedCount > 0) {
    console.warn('[ZohoCRM] Layout detail-fetch cap hit for module', module, '-', cappedCount, 'layout(s) skipped (cap=', MAX_LAYOUT_DETAIL_CALLS, '). Some fields may be missing.');
  }

  return { layoutsRes, rawFields, layoutsDebug };
}

/**
 * Fetch the writable + read-only fields for a Zoho CRM module.
 *
 * Zoho's `/settings/fields` endpoint silently omits certain field types in
 * some tenants (rich-text fields are the most commonly reported case, plus
 * some image-upload / file-upload fields and fields restricted by layout).
 * To make the dropdown reflect what's actually on the module we:
 *   1. Call `/settings/fields?type=all` (Zoho's "include every type"
 *      qualifier), falling back to the bare call if that errors.
 *   2. Walk `/settings/layouts`. For each layout that returns embedded
 *      section fields, merge those in. For layouts that come back as
 *      summaries (id+name only), fetch `/settings/layouts/{id}` and merge
 *      the detail. This is the path that surfaces fields like rich-text
 *      "Organisation overview" that `/settings/fields` drops.
 * Both endpoints surface the same per-field schema (with some key-name
 * variation handled by `mapZohoField`).
 *
 * Pass `{ debug: true }` to also receive the raw upstream payloads and a
 * per-layout/per-field source breakdown for diagnostics (admin-only).
 */
export async function getZohoCrmModuleFields(tenantId, module, options = {}) {
  if (!module) throw new Error('Module is required');
  const debug = !!options.debug;

  if (!debug) {
    const cached = moduleFieldsCache.get(moduleFieldsCacheKey(tenantId, module));
    if (cached && cached.expiresAt > Date.now()) {
      return cached.fields;
    }
  }

  // Primary fetch — must succeed (throws on failure).
  const { res: fieldsRes, qualifier: fieldsQualifier } = await fetchPrimaryZohoFields(tenantId, module);
  const byApiName = new Map();
  const fieldSource = new Map(); // api_name -> 'fields' | 'layouts'
  const fromFields = [];
  for (const raw of (fieldsRes?.fields || [])) {
    const mapped = mapZohoField(raw);
    if (!mapped) continue;
    if (!byApiName.has(mapped.api_name)) {
      byApiName.set(mapped.api_name, mapped);
      fieldSource.set(mapped.api_name, 'fields');
      fromFields.push(mapped.api_name);
    }
  }

  // Layouts pass — best-effort. A failure here just means the dropdown
  // shows whatever the primary fetch returned (i.e. the pre-#406 behaviour).
  let layoutsRes = null;
  let layoutsDebug = [];
  let layoutsError = null;
  const fromLayouts = [];
  try {
    const layoutsResult = await fetchZohoLayoutFields(tenantId, module);
    layoutsRes = layoutsResult.layoutsRes;
    layoutsDebug = layoutsResult.layoutsDebug;
    for (const { field: raw, source } of layoutsResult.rawFields) {
      const mapped = mapZohoField(raw);
      if (!mapped) continue;
      const dt = String(mapped.data_type || '').toLowerCase();
      if (LAYOUT_DATA_TYPE_DENY.has(dt)) continue;
      if (!byApiName.has(mapped.api_name)) {
        byApiName.set(mapped.api_name, mapped);
        // Record exact endpoint attribution so debug output can show
        // 'layouts_list' (embedded in the list response) vs
        // 'layouts_detail' (required a per-layout detail fetch).
        fieldSource.set(mapped.api_name, source);
        fromLayouts.push(mapped.api_name);
      }
    }
  } catch (err) {
    layoutsError = err?.message || String(err);
    console.warn('[ZohoCRM] Layout-merge failed for module', module, '-', layoutsError);
  }

  // Rich-text probe — Zoho excludes rich-text fields from BOTH
  // /settings/fields (incl. `type=all`) AND /settings/layouts. The only
  // way to discover their api_names is to fetch one record's dedicated
  // `actions/fetch_full_data` payload (v8) and inspect the returned keys.
  // Best-effort: a missing/empty/erroring probe leaves the dropdown at
  // its post-layouts shape. Costs one list call + one rich-text call per
  // cache miss per module (5-min cache), so steady-state overhead is
  // negligible. See `fetchZohoCrmRecordRichText` for the v8 endpoint
  // rationale (fixed in #419 — the prior `actions/rich_text` path is
  // undocumented and silently returns empty data).
  const fromRichText = [];
  let richTextProbeError = null;
  let richTextSampleId = null;
  let richTextKeysSeen = 0;
  try {
    const enc2 = encodeURIComponent(module);
    const listRes = await zohoCrmApiCall(tenantId, `/${enc2}?fields=id&per_page=1`);
    const sampleRow = Array.isArray(listRes?.data) && listRes.data.length > 0 ? listRes.data[0] : null;
    if (sampleRow && sampleRow.id) {
      richTextSampleId = String(sampleRow.id);
      const rt = await fetchZohoCrmRecordRichText(tenantId, module, richTextSampleId);
      const keys = Object.keys(rt);
      richTextKeysSeen = keys.length;
      for (const apiName of keys) {
        if (byApiName.has(apiName)) continue;
        const synth = apiName.replace(/__s$/i, '').replace(/_/g, ' ').trim();
        const label = synth || apiName;
        byApiName.set(apiName, {
          api_name: apiName,
          field_label: label,
          data_type: 'richtextarea',
          required: false,
          read_only: false,
          custom_field: true,
          length: null,
          pick_list_values: []
        });
        fieldSource.set(apiName, 'rich_text');
        fromRichText.push(apiName);
      }
    }
    // Module with zero records => no probe possible; dropdown unchanged.
  } catch (err) {
    richTextProbeError = err?.message || String(err);
    console.warn('[ZohoCRM] Rich-text probe failed for module', module, '-', richTextProbeError);
  }

  const fields = Array.from(byApiName.values());

  if (!debug) {
    moduleFieldsCache.set(moduleFieldsCacheKey(tenantId, module), {
      fields,
      expiresAt: Date.now() + MODULE_FIELDS_TTL_MS
    });
  }

  if (debug) {
    return {
      fields,
      debug: {
        fields_qualifier: fieldsQualifier,
        from_fields_count: fromFields.length,
        from_layouts_count: fromLayouts.length,
        added_from_layouts: fromLayouts,
        from_rich_text_count: fromRichText.length,
        added_from_rich_text: fromRichText,
        rich_text_sample_id: richTextSampleId,
        rich_text_keys_seen: richTextKeysSeen,
        rich_text_error: richTextProbeError,
        field_sources: Object.fromEntries(fieldSource),
        layouts_breakdown: layoutsDebug,
        layouts_error: layoutsError,
        raw_fields_response: fieldsRes,
        raw_layouts_response: layoutsRes
      }
    };
  }

  return fields;
}

// --- Diagnostic: hunt for a specific field across every Zoho metadata
// surface for a module. Used by the admin "Find a missing field" tool
// when a custom field (e.g. rich-text "Organisation overview") doesn't
// surface in `getZohoCrmModuleFields` and we need to know whether Zoho
// returns it at all, and if so where. Bypasses the in-memory cache.
// Collapse whitespace, underscores, and hyphens into a single space and
// lower-case so that a label-style query like "Organisation overview"
// matches an api_name like "Organisation_Overview" or a column_name like
// "organisation-overview".
function normalizeForMatch(s) {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().replace(/[\s_\-]+/g, ' ').trim();
}

function fieldMatchesQuery(raw, qLower, qNorm) {
  if (!raw) return false;
  // Label-style fields keep raw substring matching (multi-word labels are
  // already space-separated, so the original behaviour is what we want).
  const labelCandidates = [raw.field_label, raw.display_label];
  for (const c of labelCandidates) {
    if (typeof c === 'string' && c.toLowerCase().includes(qLower)) return true;
  }
  // Identifier-style fields use normalised matching so spaces in the query
  // collapse against underscores/hyphens in the api_name.
  const idCandidates = [raw.api_name, raw.name, raw.column_name];
  for (const c of idCandidates) {
    if (typeof c === 'string' && normalizeForMatch(c).includes(qNorm)) return true;
  }
  return false;
}

function summariseRawField(raw) {
  if (!raw) return null;
  return {
    api_name: raw.api_name || null,
    name: raw.name || null,
    field_label: raw.field_label || null,
    display_label: raw.display_label || null,
    column_name: raw.column_name || null,
    data_type: raw.data_type || null,
    custom_field: !!raw.custom_field,
    view_type: raw.view_type || null,
    json_type: raw.json_type || null,
    visible: raw.visible
  };
}

const MAX_RECORD_SAMPLES = 5;

export async function findZohoCrmFieldByLabel(tenantId, module, query, options = {}) {
  if (!module) throw new Error('Module is required');
  if (!query || !query.trim()) throw new Error('Search query is required');
  const qLower = query.trim().toLowerCase();
  const qNorm = normalizeForMatch(query);
  const matches = [];
  const sourceCounts = { fields: 0, layouts_list: 0, layouts_detail: 0, records: 0, rich_text: 0 };
  const errors = [];
  const pinnedRecordId = (options && options.recordId && String(options.recordId).trim()) || null;

  // 1) Primary fields fetch — we hit BOTH `/settings/fields?type=all` and
  //    plain `/settings/fields` independently so the diagnostic exhausts
  //    every fields-endpoint surface. (The cached `getZohoCrmModuleFields`
  //    short-circuits on the first non-empty response — fine for the
  //    dropdown, not enough for this diagnostic.)
  const enc = encodeURIComponent(module);
  const fieldsCountByEndpoint = {};
  for (const variant of [
    { qualifier: 'type=all', path: `/settings/fields?module=${enc}&type=all` },
    { qualifier: 'default',  path: `/settings/fields?module=${enc}` }
  ]) {
    try {
      const res = await zohoCrmApiCall(tenantId, variant.path);
      const fields = Array.isArray(res?.fields) ? res.fields : [];
      fieldsCountByEndpoint[variant.qualifier] = fields.length;
      for (const raw of fields) {
        if (fieldMatchesQuery(raw, qLower, qNorm)) {
          matches.push({
            source: 'fields',
            fields_qualifier: variant.qualifier,
            layout_id: null,
            layout_name: null,
            section_name: null,
            field: summariseRawField(raw)
          });
          sourceCounts.fields++;
        }
      }
    } catch (err) {
      errors.push({ stage: `fields:${variant.qualifier}`, error: err?.message || String(err) });
      fieldsCountByEndpoint[variant.qualifier] = null;
    }
  }
  const fieldsCount = Object.values(fieldsCountByEndpoint).reduce((a, b) => (typeof b === 'number' ? a + b : a), 0);

  // 2) Layouts: walk list inline so we keep section names; per-layout detail
  //    fetch for any layout returning a summary without embedded fields.
  let layoutsCount = 0;
  let layoutDetailCalls = 0;
  let layoutsCappedCount = 0;
  try {
    const layoutsRes = await zohoCrmApiCall(tenantId, `/settings/layouts?module=${enc}`);
    const layouts = Array.isArray(layoutsRes?.layouts) ? layoutsRes.layouts : [];
    layoutsCount = layouts.length;

    const walkLayout = (layout, layoutSource) => {
      const layoutId = layout?.id || null;
      const layoutName = layout?.name || null;
      walkLayoutSections(layout, (raw, section) => {
        if (!fieldMatchesQuery(raw, qLower, qNorm)) return;
        matches.push({
          source: layoutSource,
          fields_qualifier: null,
          layout_id: layoutId,
          layout_name: layoutName,
          section_name: section?.name || section?.display_label || null,
          field: summariseRawField(raw)
        });
        sourceCounts[layoutSource]++;
      });
    };

    for (const layout of layouts) {
      const layoutId = layout?.id;
      const hasEmbedded = Array.isArray(layout?.sections) && layout.sections.some(s => Array.isArray(s?.fields) && s.fields.length > 0);
      if (hasEmbedded) {
        walkLayout(layout, 'layouts_list');
        continue;
      }
      if (!layoutId) continue;
      if (layoutDetailCalls >= MAX_LAYOUT_DETAIL_CALLS) {
        layoutsCappedCount++;
        continue;
      }
      layoutDetailCalls++;
      try {
        const detailRes = await zohoCrmApiCall(tenantId, `/settings/layouts/${encodeURIComponent(layoutId)}?module=${enc}`);
        const detailLayout = Array.isArray(detailRes?.layouts) ? detailRes.layouts[0] : (detailRes?.layout || detailRes);
        walkLayout(detailLayout, 'layouts_detail');
      } catch (err) {
        errors.push({ stage: 'layouts_detail', layout_id: layoutId, error: err?.message || String(err) });
      }
    }
  } catch (err) {
    errors.push({ stage: 'layouts', error: err?.message || String(err) });
  }

  // 3+4) Records + rich-text probes — auto mode samples up to MAX_RECORD_SAMPLES
  //      most-recently-modified records to maximise layout coverage (rich-text
  //      fields are layout-scoped in Zoho); pinned mode probes only the
  //      operator-supplied ID so the operator can pin a known good record.
  //      Both probes run against each sample in lock-step. Errors per probe
  //      are tagged with the originating record_id.
  let recordsProbed = 0;
  let recordSampleKeys = 0;
  // Snapshot the actual key list from the first successfully-probed record
  // so the UI can render a sorted, copyable "All record keys" expander when
  // there are no matches — operators frequently scan this for renamed or
  // suffixed api_names that the literal substring search missed.
  let recordSampleKeysList = [];
  let recordSampleKeysSourceId = null;
  let richTextProbed = 0;
  const richTextKeysSeen = new Set();

  let sampleIds = [];
  if (pinnedRecordId) {
    sampleIds = [pinnedRecordId];
  } else {
    try {
      const listRes = await zohoCrmApiCall(tenantId, `/${enc}?fields=id&per_page=${MAX_RECORD_SAMPLES}&sort_by=Modified_Time&sort_order=desc`);
      const rows = Array.isArray(listRes?.data) ? listRes.data : [];
      sampleIds = rows.map(r => (r && r.id) ? String(r.id) : null).filter(Boolean);
      // No records in module = clean no-op (no error pushed, sampleIds stays []).
    } catch (err) {
      errors.push({ stage: 'records:list', error: err?.message || String(err) });
    }
  }

  // Pin the first sampled ID up-front so the api_name probe still runs even
  // if record-detail/rich-text on that ID errors mid-loop. Falls back through
  // any other sampled ID via the probe loop's last-resort assignment below.
  let firstSampleRecordId = sampleIds.length > 0 ? sampleIds[0] : null;

  for (let idx = 0; idx < sampleIds.length; idx++) {
    const sampleId = sampleIds[idx];
    // Records probe per ID
    try {
      const detailRes = await zohoCrmApiCall(tenantId, `/${enc}/${encodeURIComponent(sampleId)}`);
      const sample = Array.isArray(detailRes?.data) && detailRes.data.length > 0 ? detailRes.data[0] : null;
      if (sample && typeof sample === 'object') {
        recordsProbed++;
        const keys = Object.keys(sample);
        // Snapshot record_sample_keys from the FIRST successfully-probed
        // record (not strict idx===0) so a mid-list success populates the
        // count when sample[0] errored. Stash the sorted key list and the
        // originating record id alongside the count for the UI expander.
        if (recordSampleKeys === 0) {
          recordSampleKeys = keys.length;
          recordSampleKeysList = [...keys].sort();
          recordSampleKeysSourceId = sampleId;
        }
        for (const key of keys) {
          const val = sample[key];
          const valStr = (val == null || typeof val === 'object') ? '' : String(val);
          const keyHit = normalizeForMatch(key).includes(qNorm);
          const valHit = valStr.toLowerCase().includes(qLower);
          if (keyHit || valHit) {
            matches.push({
              source: 'records',
              fields_qualifier: null,
              layout_id: null,
              layout_name: null,
              section_name: null,
              field: {
                api_name: key,
                field_label: null,
                display_label: null,
                data_type: typeof val,
                custom_field: null,
                read_only: null,
                required: null,
                max_length: null,
                json_type: null,
                visible: null,
                sample_value_preview: valStr ? valStr.slice(0, 200) : null,
                matched_on: keyHit ? 'key' : 'value',
                source_record_id: sampleId
              }
            });
            sourceCounts.records++;
          }
        }
      }
    } catch (err) {
      errors.push({
        stage: pinnedRecordId ? 'records:detail:pinned' : 'records:detail',
        record_id: sampleId,
        error: err?.message || String(err)
      });
    }

    // Rich-text probe per ID
    try {
      const rt = await fetchZohoCrmRecordRichText(tenantId, module, sampleId);
      richTextProbed++;
      const keys = Object.keys(rt);
      for (const key of keys) richTextKeysSeen.add(key);
      for (const key of keys) {
        const val = rt[key];
        const valStr = typeof val === 'string' ? val : '';
        // Strip HTML tags + entities for matching purposes so a query like
        // "overview" matches `<p>Company overview</p>` and the preview
        // shows readable text rather than markup soup.
        const stripped = valStr
          .replace(/<[^>]+>/g, ' ')
          .replace(/&[a-z#0-9]+;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const keyHit = normalizeForMatch(key).includes(qNorm);
        const valHit = stripped.toLowerCase().includes(qLower);
        if (keyHit || valHit) {
          matches.push({
            source: 'rich_text',
            fields_qualifier: null,
            layout_id: null,
            layout_name: null,
            section_name: null,
            field: {
              api_name: key,
              field_label: null,
              display_label: null,
              data_type: 'richtextarea',
              custom_field: true,
              read_only: null,
              required: null,
              max_length: null,
              json_type: null,
              visible: null,
              sample_value_preview: stripped ? stripped.slice(0, 200) : null,
              matched_on: keyHit ? 'key' : 'value',
              source_record_id: sampleId
            }
          });
          sourceCounts.rich_text++;
        }
      }
    } catch (err) {
      errors.push({ stage: 'rich_text', record_id: sampleId, error: err?.message || String(err) });
    }
  }

  // 5) Direct api_name probe — derive 1-3 candidate api_names from the query
  //    and ask Zoho's rich-text endpoint for them explicitly. If Zoho returns
  //    a key (even with an empty value), the field exists; if Zoho 4xxs with
  //    INVALID_DATA, the spelling doesn't exist on the module. Confirms the
  //    "empty-value omission" hypothesis without needing a populated record.
  let apiNameProbeRan = false;
  let apiNameProbeCandidates = [];
  const apiNameProbeFound = [];
  if (firstSampleRecordId && matches.length === 0) {
    const trimmed = query.trim();
    const tokens = trimmed.split(/[\s_]+/).filter(Boolean);
    const titleCanonical = tokens
      .map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
      .join('_');
    const lowerTail = tokens.length > 0
      ? tokens[0].charAt(0).toUpperCase() + tokens[0].slice(1).toLowerCase()
        + (tokens.length > 1 ? '_' + tokens.slice(1).map(t => t.toLowerCase()).join('_') : '')
      : '';
    const exactAsTyped = trimmed.replace(/\s+/g, '_');
    const candidateSet = new Set([titleCanonical, lowerTail, exactAsTyped].filter(Boolean));
    // Skip candidates Zoho already returned — no point re-asking.
    for (const c of Array.from(candidateSet)) {
      if (richTextKeysSeen.has(c)) candidateSet.delete(c);
    }
    if (candidateSet.size > 0) {
      apiNameProbeCandidates = Array.from(candidateSet);
      apiNameProbeRan = true;
      try {
        const rt = await fetchZohoCrmRecordRichText(tenantId, module, firstSampleRecordId, apiNameProbeCandidates);
        for (const [key, val] of Object.entries(rt)) {
          apiNameProbeFound.push(key);
          richTextKeysSeen.add(key);
          const valStr = typeof val === 'string' ? val : '';
          const stripped = valStr
            .replace(/<[^>]+>/g, ' ')
            .replace(/&[a-z#0-9]+;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          matches.push({
            source: 'rich_text',
            fields_qualifier: null,
            layout_id: null,
            layout_name: null,
            section_name: null,
            field: {
              api_name: key,
              field_label: null,
              display_label: null,
              data_type: 'richtextarea',
              custom_field: true,
              read_only: null,
              required: null,
              max_length: null,
              json_type: null,
              visible: null,
              sample_value_preview: stripped ? stripped.slice(0, 200) : null,
              matched_on: 'api_name_probe',
              source_record_id: firstSampleRecordId
            }
          });
          sourceCounts.rich_text++;
        }
      } catch (err) {
        errors.push({
          stage: 'rich_text:api_name_probe',
          record_id: firstSampleRecordId,
          candidates: apiNameProbeCandidates,
          error: err?.message || String(err)
        });
      }
    }
  }

  const richTextKeysSeenSorted = Array.from(richTextKeysSeen).sort();
  const richTextKeys = richTextKeysSeenSorted.length;

  // Conclusion: a one-line operator-friendly summary, branched on the new
  // signals so each failure mode gets a tailored explanation.
  const richTextOnly = sourceCounts.rich_text > 0
    && sourceCounts.fields === 0
    && sourceCounts.layouts_list === 0
    && sourceCounts.layouts_detail === 0
    && sourceCounts.records === 0;
  const recordsOnly = sourceCounts.records > 0
    && sourceCounts.fields === 0
    && sourceCounts.layouts_list === 0
    && sourceCounts.layouts_detail === 0
    && sourceCounts.rich_text === 0;

  let conclusion;
  if (pinnedRecordId && recordsProbed === 0 && richTextProbed === 0) {
    const pinnedErr = errors.find(e => e.stage === 'records:detail:pinned' || (e.stage === 'rich_text' && e.record_id === pinnedRecordId));
    conclusion = `Pinned record id "${pinnedRecordId}" was not found on module "${module}"${pinnedErr ? ` (${pinnedErr.error})` : ''}. Verify the ID exists and the module name is correct.`;
  } else if (richTextOnly) {
    conclusion = `Found ${sourceCounts.rich_text} match(es) only in the dedicated /{module}/{record_id}/actions/fetch_full_data endpoint (Zoho v8) for module "${module}". This is the classic signature of a Zoho rich-text field — Zoho excludes them from /settings/fields (incl. type=all), /settings/layouts, AND the regular GET /{record} payload. The mapping dropdown will list this api_name automatically once the 5-minute metadata cache refreshes; inbound sync fetches values via the dedicated endpoint when the field is mapped.`;
  } else if (recordsOnly) {
    conclusion = `Found ${sourceCounts.records} match(es) in real ${module} record JSON, but Zoho's metadata APIs (/settings/fields, /settings/layouts) returned nothing. This is the classic signature of a Zoho "Public field" — Zoho excludes them from metadata enumeration even though the field is fully readable/writable via the records API. Use the api_name shown below in the field-mapping table's "Type api_name manually…" option to map it.`;
  } else if (matches.length > 0) {
    const sources = Array.from(new Set(matches.map(m => m.source)));
    const probedVia = apiNameProbeFound.length > 0 ? ` (api_name probe confirmed: ${apiNameProbeFound.join(', ')})` : '';
    conclusion = `Found ${matches.length} match(es) in module "${module}" via ${sources.join(', ')}${probedVia}. If the field appears here but not in the mapping dropdown, check this module's data_type (rich-text/long-text are kept; subform/file/image are excluded).`;
  } else {
    // Reusable suffix that surfaces what the api_name probe tried, regardless
    // of which no-match branch we land in. Operators were getting confused by
    // conclusions that didn't mention the probe even when it ran — see #419.
    const probeSuffix = apiNameProbeRan
      ? ` Also tried derived api_name candidates [${apiNameProbeCandidates.join(', ')}] against the rich-text endpoint, but Zoho ${apiNameProbeFound.length > 0 ? `only recognised ${apiNameProbeFound.join(', ')}` : 'recognised none of them'}.`
      : '';
    const rtErrors = errors.filter(e => typeof e.stage === 'string' && e.stage.startsWith('rich_text'));
    if (rtErrors.length > 0) {
      const summary = rtErrors.map(e => `${e.stage}: ${e.error}`).join('; ');
      conclusion = `No match for "${query}" on module "${module}". The dedicated rich-text endpoint returned errors during probing: ${summary}. Fix the upstream call before drawing conclusions about whether the field exists.${probeSuffix}`;
    } else if (richTextKeys === 0 && recordsProbed > 0 && pinnedRecordId) {
      conclusion = `Pinned record returned no rich-text keys. Either the field isn't on this record's layout, the field is empty (Zoho omits empty rich-text values from this endpoint), or the API user's profile lacks Read on rich-text fields for this module. Check Zoho admin → Setup → Users and Control → Profiles for field-level read access, or pin a record you know has the field populated.${probeSuffix}`;
    } else if (richTextKeys === 0 && recordsProbed > 0) {
      conclusion = `Sampled ${recordsProbed} record(s); the rich-text endpoint returned no keys on any of them. Either (a) every sampled record uses a layout without rich-text fields — try pinning a specific record ID using the field above, (b) Zoho's endpoint only surfaces populated rich-text values and every sampled record has all rich-text fields blank — populate the field on at least one record and retry, or (c) the API user's profile lacks Read on rich-text fields for this module.${probeSuffix}`;
    } else if (richTextKeys > 0) {
      const list = richTextKeysSeenSorted.slice(0, 20).join(', ');
      const tail = richTextKeysSeenSorted.length > 20 ? `, +${richTextKeysSeenSorted.length - 20} more` : '';
      conclusion = `Rich-text fields ARE visible on this module (${list}${tail}) but none matched "${query}".${probeSuffix} The api_name likely differs from the label — pick the right one from the list above.`;
    } else {
      conclusion = `No field on module "${module}" matched "${query}" via /settings/fields (type=all OR default), /settings/layouts (list OR per-layout detail), a sample record fetch, OR the dedicated /{module}/{record_id}/actions/fetch_full_data endpoint (Zoho v8). Most likely causes: (1) the user's Zoho profile lacks read permission on the custom field — fix in Zoho admin under Setup → Users and Control → Profiles by granting Read access on this module's field; (2) the field lives on a different Zoho module — re-run against another module; OR (3) the module has zero records so the records and rich-text probes couldn't see it (create one and retry).${probeSuffix}`;
    }
  }

  return {
    query,
    module,
    matches,
    counts: {
      fields_total: fieldsCount,
      fields_count_by_endpoint: fieldsCountByEndpoint,
      layouts_total: layoutsCount,
      layout_detail_calls: layoutDetailCalls,
      layouts_skipped_cap: layoutsCappedCount,
      records_probed: recordsProbed,
      record_sample_keys: recordSampleKeys,
      record_sample_keys_list: recordSampleKeysList,
      record_sample_keys_source_id: recordSampleKeysSourceId,
      rich_text_probed: richTextProbed,
      rich_text_keys: richTextKeys,
      rich_text_keys_seen: richTextKeysSeenSorted,
      max_record_samples: MAX_RECORD_SAMPLES,
      pinned_record_id: pinnedRecordId,
      api_name_probe_ran: apiNameProbeRan,
      api_name_probe_candidates: apiNameProbeCandidates,
      api_name_probe_found: apiNameProbeFound,
      matches_total: matches.length,
      by_source: sourceCounts
    },
    errors,
    conclusion
  };
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

/**
 * PUT a record's rich-text field values via Zoho's standard record-update
 * endpoint `PUT /{module}/{record_id}`. The Zoho v8 API directory does NOT
 * publish a dedicated rich-text write endpoint — the previous code wrote
 * to `actions/rich_text`, an undocumented and likely-deprecated path that
 * was the symmetric mistake to the read-side bug fixed in
 * `fetchZohoCrmRecordRichText`. Rich-text fields write reliably through
 * the standard update path with HTML strings included in the record body,
 * matching the shape used by every other field type elsewhere in this
 * client (see `upsertZohoCrmRecord`).
 *
 * `fieldValues` is a flat `{ api_name: html_value }` map. The record `id`
 * is added automatically. An empty/missing map short-circuits with a
 * `skipped: true` result so callers can chain unconditionally.
 */
export async function updateZohoCrmRecordRichText(tenantId, module, recordId, fieldValues) {
  if (!module) throw new Error('Module is required');
  if (!recordId) throw new Error('Record id is required');
  if (!fieldValues || typeof fieldValues !== 'object' || Object.keys(fieldValues).length === 0) {
    return { success: true, skipped: true, reason: 'no rich-text fields to write' };
  }
  const enc = encodeURIComponent(module);
  const encId = encodeURIComponent(recordId);
  const payload = {
    data: [{ id: recordId, ...fieldValues }]
  };
  const response = await zohoCrmApiCall(tenantId, `/${enc}/${encId}`, {
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

