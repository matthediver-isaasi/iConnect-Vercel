import { supabase } from './database.js';
import { getSessionMember, getSessionTenantUser } from './session.js';
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

const DEFAULT_ACCOUNTS_DOMAIN = 'https://accounts.zoho.com';
const DEFAULT_CAMPAIGNS_DOMAIN = 'https://campaigns.zoho.com';

const tokenCacheByTenant = new Map();

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[ZohoCampaigns] Cannot decrypt - no encryption key configured');
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
    console.error('[ZohoCampaigns] Decryption error:', e.message);
    return null;
  }
}

function encrypt(text) {
  if (!text) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[ZohoCampaigns] Cannot encrypt - no encryption key configured');
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
    console.error('[ZohoCampaigns] Encryption error:', e.message);
    return null;
  }
}

async function getTenantZohoCredentials(tenantId, options = {}) {
  const { bypassEnabledCheck = false } = options;
  
  if (!supabase || !tenantId) {
    return null;
  }

  try {
    const { data: integration, error } = await supabase
      .from('tenant_integrations')
      .select('credentials, is_enabled')
      .eq('tenant_id', tenantId)
      .eq('integration_type', 'zoho_campaigns')
      .single();

    if (error || !integration) {
      console.log('[ZohoCampaigns] No Zoho Campaigns integration found for tenant:', tenantId);
      return null;
    }

    if (!bypassEnabledCheck && !integration.is_enabled) {
      console.log('[ZohoCampaigns] Zoho Campaigns integration disabled for tenant:', tenantId);
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
    console.error('[ZohoCampaigns] Error fetching credentials:', error);
    return null;
  }
}

async function saveTenantZohoCredentials(tenantId, credentials, mergeWithExisting = true) {
  if (!supabase || !tenantId) return false;

  try {
    let finalCredentials = { ...credentials };

    if (mergeWithExisting) {
      const { data: existing } = await supabase
        .from('tenant_integrations')
        .select('credentials')
        .eq('tenant_id', tenantId)
        .eq('integration_type', 'zoho_campaigns')
        .single();

      if (existing?.credentials) {
        finalCredentials = { ...existing.credentials, ...credentials };
      }
    }

    if (credentials.refresh_token) {
      finalCredentials.refresh_token = encrypt(credentials.refresh_token);
    }
    if (credentials.access_token) {
      finalCredentials.access_token = encrypt(credentials.access_token);
    }

    const { error } = await supabase
      .from('tenant_integrations')
      .upsert({
        tenant_id: tenantId,
        integration_type: 'zoho_campaigns',
        credentials: finalCredentials,
        is_enabled: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'tenant_id,integration_type'
      });

    if (error) {
      console.error('[ZohoCampaigns] Error saving credentials:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[ZohoCampaigns] Error saving credentials:', error);
    return false;
  }
}

async function refreshAccessToken(tenantId, refreshToken, credentials = null) {
  if (!credentials) {
    credentials = await getTenantZohoCredentials(tenantId);
  }

  const clientId = credentials?.client_id ? decrypt(credentials.client_id) || credentials.client_id : null;
  const clientSecret = credentials?.client_secret ? decrypt(credentials.client_secret) || credentials.client_secret : null;
  const accountsDomain = credentials?.accounts_domain ? (decrypt(credentials.accounts_domain) || credentials.accounts_domain) : DEFAULT_ACCOUNTS_DOMAIN;

  if (!clientId || !clientSecret) {
    throw new Error('Zoho client credentials not configured - please set up in Integrations');
  }

  if (!refreshToken) {
    throw new Error('No refresh token available');
  }

  console.log('[ZohoCampaigns] Refreshing access token for tenant:', tenantId);

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
    console.error('[ZohoCampaigns] Token refresh error:', errorText);
    throw new Error(`Failed to refresh Zoho access token: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    console.error('[ZohoCampaigns] Token refresh error:', data.error);
    throw new Error(`Zoho token refresh failed: ${data.error}`);
  }

  const expiresAt = Date.now() + (data.expires_in * 1000);

  tokenCacheByTenant.set(tenantId, {
    token: data.access_token,
    expiresAt
  });

  await saveTenantZohoCredentials(tenantId, {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: new Date(expiresAt).toISOString()
  });

  return data.access_token;
}

export async function getZohoCampaignsAccessToken(tenantId) {
  const cached = tokenCacheByTenant.get(tenantId);
  if (cached && Date.now() < cached.expiresAt - 60000) {
    return cached.token;
  }

  const credentials = await getTenantZohoCredentials(tenantId);
  
  if (!credentials || !credentials.refresh_token) {
    throw new Error('Zoho Campaigns not connected - please complete OAuth setup');
  }

  if (credentials.access_token && credentials.expires_at) {
    const expiresAt = new Date(credentials.expires_at).getTime();
    if (Date.now() < expiresAt - 60000) {
      tokenCacheByTenant.set(tenantId, {
        token: credentials.access_token,
        expiresAt
      });
      return credentials.access_token;
    }
  }

  return refreshAccessToken(tenantId, credentials.refresh_token, credentials);
}

export async function getTenantZohoDomains(tenantId) {
  const credentials = await getTenantZohoCredentials(tenantId);
  return {
    accountsDomain: credentials?.accounts_domain ? (decrypt(credentials.accounts_domain) || credentials.accounts_domain) : DEFAULT_ACCOUNTS_DOMAIN,
    campaignsDomain: credentials?.campaigns_domain ? (decrypt(credentials.campaigns_domain) || credentials.campaigns_domain) : DEFAULT_CAMPAIGNS_DOMAIN
  };
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

export async function zohoCampaignsApiCall(tenantId, endpoint, options = {}) {
  const token = await getZohoCampaignsAccessToken(tenantId);
  const { campaignsDomain } = await getTenantZohoDomains(tenantId);
  
  const url = `${campaignsDomain}/api/v1.1${endpoint}`;
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[ZohoCampaigns] API error:', response.status, errorText);
    throw new Error(`Zoho Campaigns API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

export async function getZohoCampaignsLists(tenantId) {
  try {
    const data = await zohoCampaignsApiCall(tenantId, '/getmailinglists?resfmt=JSON&range=100');
    
    if (data.status === 'error') {
      throw new Error(data.message || 'Failed to fetch lists');
    }
    
    const lists = data.list_of_details || [];
    return lists.map(list => ({
      listkey: list.listkey,
      listname: list.listname,
      listdesc: list.listdesc || '',
      subscriber_count: parseInt(list.subscriber_count) || 0,
      unsubscriber_count: parseInt(list.unsubscriber_count) || 0
    }));
  } catch (error) {
    console.error('[ZohoCampaigns] Error fetching lists:', error);
    throw error;
  }
}

export async function addSubscriberToList(tenantId, listKey, subscriber) {
  try {
    const contactInfo = JSON.stringify({
      'Contact Email': subscriber.email,
      'First Name': subscriber.first_name || '',
      'Last Name': subscriber.last_name || ''
    });

    const params = new URLSearchParams({
      resfmt: 'JSON',
      listkey: listKey,
      contactinfo: contactInfo
    });

    const data = await zohoCampaignsApiCall(tenantId, `/json/listsubscribe?${params.toString()}`, {
      method: 'POST'
    });
    
    if (data.status === 'error') {
      console.error('[ZohoCampaigns] Add subscriber error for email:', subscriber.email, 'Error:', data);
      return { success: false, error: data.message || 'Failed to add subscriber', email: subscriber.email };
    }
    
    return { success: true, data };
  } catch (error) {
    console.error('[ZohoCampaigns] Error adding subscriber:', error);
    return { success: false, error: error.message };
  }
}

export async function removeSubscriberFromList(tenantId, listKey, email) {
  try {
    const params = new URLSearchParams({
      resfmt: 'JSON',
      listkey: listKey,
      contactemail: email
    });

    const data = await zohoCampaignsApiCall(tenantId, `/json/listunsubscribe?${params.toString()}`, {
      method: 'POST'
    });
    
    if (data.status === 'error') {
      console.error('[ZohoCampaigns] Remove subscriber error for email:', email, 'Error:', data);
      return { success: false, error: data.message || 'Failed to remove subscriber', email };
    }
    
    return { success: true, data };
  } catch (error) {
    console.error('[ZohoCampaigns] Error removing subscriber:', error);
    return { success: false, error: error.message };
  }
}

export async function syncMemberToZohoLists(tenantId, member, preferences) {
  const results = [];
  
  const { data: categories, error: catError } = await supabase
    .from('communication_category')
    .select('id, name, zoho_list_id')
    .eq('tenant_id', tenantId)
    .not('zoho_list_id', 'is', null);

  if (catError || !categories?.length) {
    console.log('[ZohoCampaigns] No categories with Zoho list mappings found');
    return results;
  }

  const isOptedOutAll = member.communications_opted_out_all === true;

  for (const category of categories) {
    const preference = preferences.find(p => p.category_id === category.id);
    const isSubscribed = !isOptedOutAll && (preference?.is_subscribed !== false);

    try {
      if (isSubscribed) {
        const result = await addSubscriberToList(tenantId, category.zoho_list_id, {
          email: member.email,
          first_name: member.first_name,
          last_name: member.last_name
        });
        results.push({ category: category.name, action: 'subscribe', ...result });
      } else {
        const result = await removeSubscriberFromList(tenantId, category.zoho_list_id, member.email);
        results.push({ category: category.name, action: 'unsubscribe', ...result });
      }
    } catch (error) {
      results.push({ category: category.name, action: 'error', error: error.message });
    }
  }

  return results;
}

export async function getZohoOAuthUrl(tenantId, redirectUri, signedState) {
  const credentials = await getTenantZohoCredentials(tenantId, { bypassEnabledCheck: true });
  const clientId = credentials?.client_id ? decrypt(credentials.client_id) || credentials.client_id : null;
  const accountsDomain = credentials?.accounts_domain ? (decrypt(credentials.accounts_domain) || credentials.accounts_domain) : DEFAULT_ACCOUNTS_DOMAIN;

  if (!clientId) {
    throw new Error('Zoho client ID not configured - please set up in Integrations');
  }

  const scope = 'ZohoCampaigns.contact.CREATE,ZohoCampaigns.contact.READ,ZohoCampaigns.contact.UPDATE';
  
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

export async function exchangeCodeForTokens(tenantId, code, redirectUri) {
  const credentials = await getTenantZohoCredentials(tenantId, { bypassEnabledCheck: true });
  const clientId = credentials?.client_id ? decrypt(credentials.client_id) || credentials.client_id : null;
  const clientSecret = credentials?.client_secret ? decrypt(credentials.client_secret) || credentials.client_secret : null;
  const accountsDomain = credentials?.accounts_domain ? (decrypt(credentials.accounts_domain) || credentials.accounts_domain) : DEFAULT_ACCOUNTS_DOMAIN;

  if (!clientId || !clientSecret) {
    throw new Error('Zoho client credentials not configured - please set up in Integrations');
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
    console.error('[ZohoCampaigns] Token exchange error:', errorText);
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

export async function connectZohoCampaigns(tenantId, code, redirectUri) {
  const tokens = await exchangeCodeForTokens(tenantId, code, redirectUri);
  await saveTenantZohoCredentials(tenantId, tokens);
  return { success: true };
}

export async function isZohoCampaignsConnected(tenantId) {
  const credentials = await getTenantZohoCredentials(tenantId);
  return !!(credentials && credentials.refresh_token);
}

export async function hasZohoCredentialsConfigured(tenantId) {
  const credentials = await getTenantZohoCredentials(tenantId, { bypassEnabledCheck: true });
  const clientId = credentials?.client_id ? decrypt(credentials.client_id) || credentials.client_id : null;
  return !!clientId;
}

export function clearTenantZohoTokenCache(tenantId) {
  tokenCacheByTenant.delete(tenantId);
}

export async function getOrCreateWebhookSecret(tenantId) {
  const credentials = await getTenantZohoCredentials(tenantId);
  
  if (credentials?.webhook_secret) {
    return decrypt(credentials.webhook_secret) || credentials.webhook_secret;
  }
  
  const newSecret = crypto.randomBytes(32).toString('hex');
  await saveTenantZohoCredentials(tenantId, { webhook_secret: encrypt(newSecret) });
  return newSecret;
}

export async function validateWebhookSecret(tenantId, providedSecret) {
  if (!providedSecret) return false;
  
  const credentials = await getTenantZohoCredentials(tenantId);
  if (!credentials?.webhook_secret) return false;
  
  const storedSecret = decrypt(credentials.webhook_secret) || credentials.webhook_secret;
  return storedSecret === providedSecret;
}
