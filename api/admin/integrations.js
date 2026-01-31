import { getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
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

function encryptCredentials(credentials) {
  if (!credentials) return {};
  const encrypted = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (value && typeof value === 'string') {
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
  const unmaskedFields = ['region', 'accounts_domain', 'campaigns_domain'];
  
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

  const tenantUser = await getSessionTenantUser(req);
  
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantUser.tenant_id;

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

      const maskedIntegrations = (integrations || []).map(integration => ({
        ...integration,
        credentials: maskCredentials(decryptCredentials(integration.credentials)),
        has_credentials: Object.keys(integration.credentials || {}).length > 0
      }));

      res.json({ success: true, integrations: maskedIntegrations });
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

      const validTypes = ['zoom', 'zoho_campaigns', 'xero'];
      if (!validTypes.includes(integration_type)) {
        return res.status(400).json({ error: 'Invalid integration type' });
      }

      const { data: existing } = await supabase
        .from('tenant_integrations')
        .select('id, credentials')
        .eq('tenant_id', tenantId)
        .eq('integration_type', integration_type)
        .single();

      let encryptedCreds = {};
      
      if (credentials) {
        const existingDecrypted = existing ? decryptCredentials(existing.credentials) : {};
        const mergedCreds = { ...existingDecrypted };
        
        for (const [key, value] of Object.entries(credentials)) {
          if (value !== undefined && value !== null && !value.includes('****')) {
            mergedCreds[key] = value;
          }
        }
        
        encryptedCreds = encryptCredentials(mergedCreds);
      }

      let result;
      
      if (existing) {
        const updateData = {
          updated_at: new Date().toISOString()
        };
        
        if (credentials && Object.keys(encryptedCreds).length > 0) {
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

      console.log('[Integrations] Saved:', integration_type, 'for tenant:', tenantId);
      
      res.json({ 
        success: true, 
        integration: {
          ...result,
          credentials: maskCredentials(decryptCredentials(result.credentials)),
          has_credentials: Object.keys(result.credentials || {}).length > 0
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

export { decrypt, decryptCredentials };
