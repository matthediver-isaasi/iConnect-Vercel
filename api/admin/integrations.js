import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import { getTrustedBaseUrlForTenant } from '../_lib/publicBaseUrl.js';
import { normalizeAutoRetryPolicy, validateAutoRetryPolicy } from '../_lib/gocardlessAutoRetry.js';
import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET;

if (!ENCRYPTION_KEY) {
  console.warn('[Integrations] WARNING: INTEGRATION_ENCRYPTION_KEY or SESSION_SECRET not set - credentials cannot be encrypted');
}

function encrypt(text) {
  if (!text) return null;
  if (!ENCRYPTION_KEY) {
    throw new Error('Encryption key not configured - cannot store credentials');
  }
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  if (!ENCRYPTION_KEY) {
    console.error('[Integrations] Cannot decrypt - no encryption key configured');
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
    console.error('[Integrations] Decryption error:', e.message);
    return null;
  }
}

const NON_SECRET_FIELDS = [
  'region', 'accounts_domain', 'campaigns_domain', 'stripe_mode_forms',
  'stripe_mode_events', 'stripe_mode_membership', 'stripe_mode_jobs',
  'stripe_mode_fundraising', 'environment', 'country',
  'auto_retry_enabled', 'auto_retry_interval_days', 'auto_retry_max_attempts',
];

function encryptCredentials(credentials) {
  if (!credentials) return {};
  const encrypted = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (value && typeof value === 'string' && !NON_SECRET_FIELDS.includes(key)) {
      encrypted[key] = encrypt(value);
    } else {
      encrypted[key] = value;
    }
  }
  return encrypted;
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

function maskCredentials(credentials) {
  if (!credentials) return {};
  const masked = {};
  // Fields that should not be masked (non-sensitive configuration values)
  const unmaskedFields = NON_SECRET_FIELDS;
  
  for (const [key, value] of Object.entries(credentials)) {
    if (unmaskedFields.includes(key)) {
      // Return these fields as-is (they're not sensitive)
      masked[key] = value;
    } else if (value && typeof value === 'string' && value.length > 8) {
      masked[key] = value.substring(0, 4) + '****' + value.substring(value.length - 4);
    } else if (value) {
      masked[key] = '****';
    } else {
      masked[key] = null;
    }
  }
  return masked;
}

function mergeCredentialUpdates(existingCredentials = {}, incomingCredentials = {}) {
  const merged = { ...existingCredentials };
  for (const [key, value] of Object.entries(incomingCredentials || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.includes('****')) continue;
    merged[key] = value;
  }
  return merged;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext?.isAuthenticated || !tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!await hasAdminAccess(tenantContext)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const tenantId = tenantContext.tenantId;

  if (req.method === 'GET') {
    try {
      const { data: integrations, error } = await supabase
        .from('tenant_integrations')
        .select('*')
        .eq('tenant_id', tenantId);

      if (error) {
        console.error('[Integrations] Get error:', error);
        return res.status(500).json({ error: 'Failed to fetch integrations' });
      }

      const maskedIntegrations = (integrations || []).map(integration => {
        const decrypted = decryptCredentials(integration.credentials);
        return {
          ...integration,
          credentials: maskCredentials(decrypted),
          ...(integration.integration_type === 'gocardless'
            ? { auto_retry_policy: normalizeAutoRetryPolicy(decrypted) }
            : {}),
          has_credentials: integration.integration_type === 'gocardless'
            ? !!decrypted.access_token
            : Object.keys(integration.credentials || {}).length > 0
        };
      });

      // Tenant-scoped GoCardless webhook URL: admins register this in the
      // GoCardless dashboard so events are verified against THIS tenant's
      // webhook secret. Built on the tenant-trusted base URL (never the raw
      // request host — see publicBaseUrl.js).
      const baseUrl = await getTrustedBaseUrlForTenant(req, supabase, tenantId);
      const gocardlessWebhookUrl = `${baseUrl}/api/webhooks/gocardless?tenant=${encodeURIComponent(tenantId)}`;

      res.json({ success: true, integrations: maskedIntegrations, gocardless_webhook_url: gocardlessWebhookUrl });
    } catch (error) {
      console.error('[Integrations] Get error:', error);
      res.status(500).json({ error: 'Failed to fetch integrations' });
    }
  } else if (req.method === 'POST' || req.method === 'PUT') {
    try {
      const { integration_type, credentials, is_enabled } = req.body;

      if (!integration_type) {
        return res.status(400).json({ error: 'integration_type is required' });
      }

      const validTypes = ['zoom', 'zoho_campaigns', 'xero', 'stripe', 'quickbooks', 'gocardless', 'adzuna'];
      if (!validTypes.includes(integration_type)) {
        return res.status(400).json({ error: 'Invalid integration type' });
      }

      let autoRetryPolicy = null;
      if (integration_type === 'gocardless'
          && (req.body.auto_retry_policy !== undefined || req.body.gocardless_auto_retry !== undefined)) {
        try {
          autoRetryPolicy = validateAutoRetryPolicy(
            req.body.auto_retry_policy ?? req.body.gocardless_auto_retry,
          );
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }
      }

      const { data: existing } = await supabase
        .from('tenant_integrations')
        .select('id, credentials')
        .eq('tenant_id', tenantId)
        .eq('integration_type', integration_type)
        .single();

      let encryptedCreds = {};
      
      if (credentials || autoRetryPolicy) {
        const existingDecrypted = existing ? decryptCredentials(existing.credentials) : {};
        const mergedCreds = mergeCredentialUpdates(existingDecrypted, credentials);
        if (autoRetryPolicy) {
          mergedCreds.auto_retry_enabled = autoRetryPolicy.enabled;
          mergedCreds.auto_retry_interval_days = autoRetryPolicy.intervalDays;
          mergedCreds.auto_retry_max_attempts = autoRetryPolicy.maxAttempts;
        }
        encryptedCreds = encryptCredentials(mergedCreds);
      }

      let result;
      
      if (existing) {
        const updateData = {
          updated_at: new Date().toISOString()
        };
        
        if ((credentials || autoRetryPolicy) && Object.keys(encryptedCreds).length > 0) {
          updateData.credentials = encryptedCreds;
        }
        
        if (is_enabled !== undefined) {
          updateData.is_enabled = is_enabled;
        }
        
        const { data, error } = await supabase
          .from('tenant_integrations')
          .update(updateData)
          .eq('id', existing.id)
          .select()
          .single();
          
        if (error) throw error;
        result = data;
      } else {
        const { data, error } = await supabase
          .from('tenant_integrations')
          .insert({
            tenant_id: tenantId,
            integration_type,
            credentials: encryptedCreds,
            is_enabled: is_enabled || false
          })
          .select()
          .single();
          
        if (error) throw error;
        result = data;
      }

      if (integration_type === 'adzuna' && is_enabled === false) {
        const { error: retireError } = await supabase
          .from('job_posting')
          .update({ status: 'expired' })
          .eq('tenant_id', tenantId)
          .eq('external_source', 'adzuna')
          .eq('status', 'active');
        if (retireError) throw retireError;
      }

      if (integration_type === 'gocardless' && (autoRetryPolicy || is_enabled === false)) {
        let retryStateUpdate = null;
        if (is_enabled === false || !autoRetryPolicy?.enabled || autoRetryPolicy?.maxAttempts === 0) {
          retryStateUpdate = {
            auto_retry_next_at: null,
            auto_retry_last_outcome: 'disabled_policy',
            auto_retry_last_error: null,
            updated_at: new Date().toISOString(),
          };
        }
        if (retryStateUpdate) {
          const { error: retryStateError } = await supabase
            .from('membership_payment_plans')
            .update(retryStateUpdate)
            .eq('tenant_id', tenantId);
          if (retryStateError) throw retryStateError;
        }
      }

      console.log('[Integrations] Saved:', integration_type, 'for tenant:', tenantId);
      
      const decryptedResult = decryptCredentials(result.credentials);
      res.json({
        success: true, 
        integration: {
          ...result,
          credentials: maskCredentials(decryptedResult),
          ...(integration_type === 'gocardless'
            ? { auto_retry_policy: normalizeAutoRetryPolicy(decryptedResult) }
            : {}),
          has_credentials: integration_type === 'gocardless'
            ? !!decryptedResult.access_token
            : Object.keys(result.credentials || {}).length > 0
        }
      });
    } catch (error) {
      console.error('[Integrations] Save error:', error);
      res.status(500).json({ error: 'Failed to save integration' });
    }
  } else if (req.method === 'DELETE') {
    try {
      const { integration_type } = req.query;

      if (!integration_type) {
        return res.status(400).json({ error: 'integration_type is required' });
      }

      const { error } = await supabase
        .from('tenant_integrations')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('integration_type', integration_type);

      if (error) {
        console.error('[Integrations] Delete error:', error);
        return res.status(500).json({ error: 'Failed to delete integration' });
      }

      if (integration_type === 'adzuna') {
        const { error: retireError } = await supabase
          .from('job_posting')
          .update({ status: 'expired' })
          .eq('tenant_id', tenantId)
          .eq('external_source', 'adzuna')
          .eq('status', 'active');
        if (retireError) {
          return res.status(500).json({ error: 'Adzuna was disconnected but imported jobs could not be retired' });
        }
      }
      if (integration_type === 'gocardless') {
        const { error: retryStateError } = await supabase
          .from('membership_payment_plans')
          .update({
            auto_retry_next_at: null,
            auto_retry_last_outcome: 'disabled_policy',
            auto_retry_last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq('tenant_id', tenantId);
        if (retryStateError) {
          return res.status(500).json({ error: 'GoCardless was disconnected but automatic retry schedules could not be cleared' });
        }
      }

      console.log('[Integrations] Deleted:', integration_type, 'for tenant:', tenantId);
      res.json({ success: true });
    } catch (error) {
      console.error('[Integrations] Delete error:', error);
      res.status(500).json({ error: 'Failed to delete integration' });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}

export { decrypt, decryptCredentials, encryptCredentials, maskCredentials, mergeCredentialUpdates };
